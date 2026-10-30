"""JSONL-адаптер загрузчика для запуска из Electron.

Запуск: ``python -m ymd.ipc --token ... --url ... --dir ...``.

Контракт: единственный канал связи с фронтендом — ``stdout``, где каждая строка
является самостоятельным JSON-объектом (JSONL). Любой другой вывод, включая
логи и traceback, направляется в ``stderr``.
"""

import argparse
import itertools
import os
import json
import logging
import sys
import traceback
from collections.abc import Generator, Iterable, Iterator
from pathlib import Path
from typing import Any, Optional, Union
from urllib.parse import urlparse

from yandex_music import Client, Track
from yandex_music.exceptions import NetworkError, UnauthorizedError

from ymd import core
from ymd.cli import ALBUM_RE, ARTIST_RE, PLAYLIST_RE, TRACK_RE

DEFAULT_TIMEOUT = 20
DEFAULT_TRIES = 20
DEFAULT_RETRY_DELAY = 5
DEFAULT_PATH_PATTERN = "{artist}/{album}/{title}"

FETCH_PAGE_SIZE = 10
COVER_RESOLUTION = core.DEFAULT_COVER_RESOLUTION
COMPATIBILITY_LEVEL = 1

# Псевдонимы заполнителей шаблона пути в привычной для интерфейса записи.
PATH_PLACEHOLDERS: dict[str, str] = {
    "{artist}": "#track-artist",
    "{track_artist}": "#track-artist",
    "{album_artist}": "#album-artist",
    "{album}": "#album",
    "{title}": "#title",
    "{year}": "#year",
    "{number}": "#number",
    "{number_padded}": "#number-padded",
    "{artist_id}": "#artist-id",
    "{album_id}": "#album-id",
    "{track_id}": "#track-id",
}

# Реальный stdout сохраняется на импорте: во время работы библиотек он подменяется
# на stderr, чтобы случайные print() не ломали JSONL-поток.
_STDOUT = sys.stdout

logger = logging.getLogger("yandex-music-downloader.ipc")

# Секретный токен текущего запуска (для маскирования в stderr/stdout).
_SECRET_TOKEN: str | None = None


def _mask_text(value: Any) -> Any:
    """Замаскировать токен в строке (и рекурсивно в контейнерах)."""
    global _SECRET_TOKEN
    if isinstance(value, str):
        if _SECRET_TOKEN:
            return value.replace(_SECRET_TOKEN, "[REDACTED]")
        return value
    if isinstance(value, dict):
        return {k: _mask_text(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_mask_text(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_mask_text(item) for item in value)
    return value


class _MaskingStream:
    """Обёртка потока, вырезающая токен из любого вывода."""

    def __init__(self, stream: Any, secret: str | None) -> None:
        self._stream = stream
        self._secret = secret

    def write(self, data: Any) -> int:
        if self._secret and isinstance(data, str):
            data = data.replace(self._secret, "[REDACTED]")
        elif self._secret and isinstance(data, (bytes, bytearray)):
            try:
                secret_bytes = self._secret.encode()
                data = bytes(data).replace(secret_bytes, b"[REDACTED]")
            except Exception:  # noqa: BLE001
                pass
        return self._stream.write(data)

    def flush(self) -> None:
        return self._stream.flush()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)


def resolve_token(args: argparse.Namespace) -> str | None:
    """Токен: CLI (--token) или переменные окружения (без утечки в argv)."""
    if getattr(args, "token", None):
        return str(args.token)
    for name in ("YMD_TOKEN", "YANDEX_MUSIC_TOKEN", "YM_TOKEN", "YANDEX_MUSIC_ACCESS_TOKEN"):
        value = os.environ.get(name)
        if value:
            return value
    return None


def emit(event: dict[str, Any]) -> None:
    """Записать одно JSONL-событие в stdout и сбросить буфер."""
    _STDOUT.write(json.dumps(_mask_text(event), ensure_ascii=False) + "\n")
    _STDOUT.flush()


def emit_error(code: str, message: str) -> None:
    emit({"type": "error", "code": code, "message": message})


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m ymd.ipc",
        description="JSONL-адаптер загрузчика Яндекс.Музыки (для Electron)",
    )
    parser.add_argument("--token", required=False, default=None, metavar="<Токен>")
    parser.add_argument("--url", required=True, metavar="<URL>")
    parser.add_argument("--dir", required=True, type=Path, metavar="<Папка>")
    parser.add_argument(
        "--quality",
        type=int,
        choices=[0, 1, 2],
        default=int(core.CoreTrackQuality.LOSSLESS),
        help="0 - низкое, 1 - оптимальное, 2 - лучшее (по умолчанию: 2)",
    )
    parser.add_argument("--embed-cover", action="store_true")
    parser.add_argument(
        "--lyrics-format",
        choices=[str(item) for item in core.LyricsFormat],
        default=str(core.LyricsFormat.NONE),
    )
    parser.add_argument("--skip-existing", action="store_true")
    parser.add_argument(
        "--path-pattern",
        default=DEFAULT_PATH_PATTERN,
        metavar="<Шаблон>",
        help=(
            "Шаблон пути. Поддерживаются {artist}, {album_artist}, {album}, "
            "{title}, {year}, {number}, {number_padded}, {artist_id}, "
            "{album_id}, {track_id} и заполнители вида #title"
        ),
    )
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    parser.add_argument("--tries", type=int, default=DEFAULT_TRIES)
    parser.add_argument("--retry-delay", type=int, default=DEFAULT_RETRY_DELAY)
    parser.add_argument("--debug", action="store_true")
    return parser


def parse_source(url: str) -> dict[str, str]:
    """Определить тип источника (исполнитель, альбом, трек, плейлист) по URL."""
    path = urlparse(url).path
    if match := ARTIST_RE.search(path):
        return {"artist_id": match.group(1)}
    if match := ALBUM_RE.search(path):
        return {"album_id": match.group(1)}
    if match := TRACK_RE.search(path):
        return {"track_id": match.group(1)}
    if match := PLAYLIST_RE.search(path):
        return {"playlist_id": match.group(1)}
    raise ValueError("URL должен указывать на исполнителя, альбом, трек или плейлист")


def normalize_path_pattern(raw: str) -> Path:
    """Привести шаблон пути к заполнителям, которые понимает core.prepare_base_path."""
    text = raw.strip()
    if not text:
        raise ValueError("Шаблон пути не может быть пустым")
    # Блокировка выхода за пределы каталога загрузки.
    if ".." in text:
        raise ValueError("Шаблон пути не может содержать '..'")
    candidate = Path(text)
    if candidate.is_absolute():
        raise ValueError("Шаблон пути не может быть абсолютным")
    if any(part in ("..",) for part in candidate.parts):
        raise ValueError("Шаблон пути не может содержать '..'")
    for alias, placeholder in PATH_PLACEHOLDERS.items():
        text = text.replace(alias, placeholder)
    return Path(text)


def track_label(track: Track) -> str:
    """Человекочитаемое название трека для событий прогресса."""
    artist = ""
    if artists := track.artists:
        artist = artists[0].name or ""
    title = core.full_title(track)
    if artist and title:
        return f"{artist} - {title}"
    return artist or title or ""


def account_name(client: Client) -> str:
    """Имя аккаунта для события auth_ok (никогда не прерывает работу)."""
    try:
        attr = getattr(client, "account_status", None)
        status = attr() if callable(attr) else attr
    except Exception:  # noqa: BLE001 - имя аккаунта не критично
        return ""
    account = getattr(status, "account", None)
    login = getattr(account, "login", None)
    if login:
        return str(login)
    return str(account) if account is not None else ""


def iter_album_tracks(
    client: Client, album_ids: Iterable[Union[int, str]]
) -> Iterator[Track]:
    for album_id in album_ids:
        full_album = client.albums_with_tracks(album_id)
        if not full_album or not full_album.volumes:
            continue
        yield from itertools.chain.from_iterable(full_album.volumes)


def iter_artist_albums(client: Client, artist_id: str) -> Iterator[int]:
    page = 0
    while True:
        albums_info = client.artists_direct_albums(artist_id, page)
        if not albums_info:
            return
        for album in albums_info.albums:
            if album.id is not None and album.available:
                yield album.id
        pager = albums_info.pager
        if pager is None:
            return
        page = pager.page + 1
        if pager.per_page * page >= pager.total:
            return


def build_queue(
    client: Client, source: dict[str, str]
) -> tuple[Iterator[Track], int, str]:
    """Построить генератор треков, их общее количество и заголовок очереди."""
    if "artist_id" in source:
        artist_id = source["artist_id"]
        artists = client.artists(artist_id)
        if not artists:
            raise LookupError("Исполнитель не найден")
        artist = artists[0]
        total = 0
        if counts := getattr(artist, "counts", None):
            total = int(getattr(counts, "tracks", None) or 0)
        tracks = iter_album_tracks(
            client, iter_artist_albums(client, artist_id)
        )
        return tracks, total, core.full_title(artist)

    if "album_id" in source:
        album = client.albums_with_tracks(source["album_id"])
        if album is None:
            raise LookupError("Альбом не найден")
        total = int(album.track_count or 0)
        album_id = album.id if album.id is not None else source["album_id"]
        return iter_album_tracks(client, (album_id,)), total, core.full_title(album)

    if "track_id" in source:
        tracks = client.tracks(source["track_id"])
        if not tracks:
            raise LookupError("Трек не найден")
        return iter(tracks), 1, track_label(tracks[0])

    playlist = client.playlist(source["playlist_id"])
    if playlist is None:
        raise LookupError("Плейлист не найден")
    total = int(playlist.track_count or 0)
    title = playlist.title or ""

    def playlist_tracks_gen() -> Generator[Track, None, None]:
        playlist_tracks = playlist.fetch_tracks()
        for index in range(0, len(playlist_tracks), FETCH_PAGE_SIZE):
            chunk = playlist_tracks[index : index + FETCH_PAGE_SIZE]
            yield from client.tracks([item.id for item in chunk])

    return playlist_tracks_gen(), total, title


def already_downloaded(save_path: Path) -> bool:
    return any(
        Path(str(save_path) + suffix).is_file()
        for suffix in core.AUDIO_FILE_SUFFIXES
    )


def download_queue(
    client: Client,
    args: argparse.Namespace,
    path_pattern: Path,
    source: dict[str, str],
) -> int:
    """Скачать очередь и вернуть код возврата процесса."""
    try:
        tracks, total, title = build_queue(client, source)
    except LookupError as error:
        emit_error("NOT_FOUND", str(error))
        return 4

    emit({"type": "queue_info", "total": total, "title": title})

    stats = {"downloaded": 0, "skipped": 0, "errors": 0}
    covers_cache: dict[int, core.AlbumCover] = {}
    lyrics_format = core.LyricsFormat(args.lyrics_format)
    quality = core.CoreTrackQuality(args.quality)
    total_for_events = total or 0
    current = 0

    for track in tracks:
        current += 1
        label = track_label(track)

        if not getattr(track, "available", True):
            stats["skipped"] += 1
            emit(
                {
                    "type": "track_progress",
                    "current": current,
                    "total": total_for_events,
                    "title": label,
                    "status": "skipped",
                    "message": "Трек недоступен для скачивания",
                }
            )
            continue

        try:
            save_path = args.dir / core.prepare_base_path(path_pattern, track)
            base_dir = Path(args.dir).resolve()
            if not save_path.resolve().is_relative_to(base_dir):
                raise ValueError("Путь выходит за пределы каталога загрузки")
        except Exception as error:  # noqa: BLE001 - ошибка одного трека не фатальна
            traceback.print_exc(file=sys.stderr)
            stats["errors"] += 1
            emit(
                {
                    "type": "track_progress",
                    "current": current,
                    "total": total_for_events,
                    "title": label,
                    "status": "error",
                    "message": f"Не удалось подготовить путь: {error}",
                }
            )
            continue

        if args.skip_existing and already_downloaded(save_path):
            stats["skipped"] += 1
            emit(
                {
                    "type": "track_progress",
                    "current": current,
                    "total": total_for_events,
                    "title": label,
                    "status": "skipped",
                    "path": str(save_path),
                }
            )
            continue

        emit(
            {
                "type": "track_progress",
                "current": current,
                "total": total_for_events,
                "title": label,
                "status": "downloading",
            }
        )

        try:
            save_dir = save_path.parent
            if not save_dir.is_dir():
                save_dir.mkdir(parents=True, exist_ok=True)
            downloadable = core.to_downloadable_track(track, quality, save_path)
            core.download_track(
                track_info=downloadable,
                lyrics_format=lyrics_format,
                embed_cover=args.embed_cover,
                cover_resolution=COVER_RESOLUTION,
                covers_cache=covers_cache if args.embed_cover else None,
                compatibility_level=COMPATIBILITY_LEVEL,
            )
        except Exception as error:  # noqa: BLE001 - ошибка одного трека не фатальна
            logger.debug("Ошибка при скачивании трека", exc_info=True)
            traceback.print_exc(file=sys.stderr)
            stats["errors"] += 1
            emit(
                {
                    "type": "track_progress",
                    "current": current,
                    "total": total_for_events,
                    "title": label,
                    "status": "error",
                    "message": str(error) or error.__class__.__name__,
                }
            )
            continue

        stats["downloaded"] += 1
        emit(
            {
                "type": "track_progress",
                "current": current,
                "total": total_for_events,
                "title": label,
                "status": "done",
                "path": str(downloadable.path),
            }
        )

    emit({"type": "finished", **stats})
    return 0 if stats["errors"] == 0 else 1


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    token = resolve_token(args)
    global _SECRET_TOKEN
    _SECRET_TOKEN = token

    # Маскируем токен в stderr ещё до настройки логирования.
    masked_stderr = _MaskingStream(sys.stderr, token)
    sys.stderr = masked_stderr

    logging.basicConfig(
        stream=sys.stderr,
        format="%(asctime)s |%(levelname)s| %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        level=logging.DEBUG if args.debug else logging.ERROR,
    )

    # Весь невольный вывод библиотек уводим в stderr, чтобы stdout оставался JSONL.
    sys.stdout = sys.stderr

    if not token:
        emit_error("UNAUTHORIZED", "Токен не передан (используйте --token или YMD_TOKEN)")
        return 3

    args.token = token

    try:
        path_pattern = normalize_path_pattern(args.path_pattern)
    except ValueError as error:
        emit_error("INVALID_ARGUMENT", str(error))
        return 2

    try:
        source = parse_source(args.url)
    except ValueError as error:
        emit_error("INVALID_URL", str(error))
        return 2

    try:
        client = core.init_client(
            token=token,
            timeout=args.timeout,
            max_try_count=args.tries,
            retry_delay=args.retry_delay,
        )
    except UnauthorizedError:
        emit_error("UNAUTHORIZED", "Токен недействителен или истёк")
        return 3
    except NetworkError as error:
        traceback.print_exc(file=sys.stderr)
        emit_error("NETWORK", f"Сетевая ошибка при авторизации: {error}")
        return 5
    except Exception as error:  # noqa: BLE001 - последний барьер перед фронтендом
        traceback.print_exc(file=sys.stderr)
        emit_error("INTERNAL", f"Не удалось авторизоваться: {error}")
        return 5

    emit({"type": "auth_ok", "account": account_name(client)})

    try:
        return download_queue(client, args, path_pattern, source)
    except UnauthorizedError:
        emit_error("UNAUTHORIZED", "Токен недействителен или истёк")
        return 3
    except NetworkError as error:
        traceback.print_exc(file=sys.stderr)
        emit_error("NETWORK", f"Сетевая ошибка: {error}")
        return 5
    except ValueError as error:
        emit_error("INTERNAL", str(error))
        return 2
    except Exception as error:  # noqa: BLE001 - последний барьер перед фронтендом
        traceback.print_exc(file=sys.stderr)
        emit_error("INTERNAL", str(error) or error.__class__.__name__)
        return 5


if __name__ == "__main__":
    sys.exit(main())
