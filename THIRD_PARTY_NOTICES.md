# Third-party notices

The Mosaic Box Editor application is licensed under MIT; see LICENSE.
Third-party components retain their respective licenses.

## FFmpeg / ffprobe

- Build: `9.0.1-full_build-www.gyan.dev`, unmodified Windows x64 static binaries.
- License: GPL version 3. Original text and build configuration are in `licenses/ffmpeg/` in the portable distribution (in source: `src-tauri/resources/licenses/ffmpeg/`).
- Supplier: https://www.gyan.dev/ffmpeg/builds/
- Original binary package: https://github.com/GyanD/codexffmpeg/releases/tag/9.0.1
- FFmpeg source revision supplied with this build: https://github.com/FFmpeg/FFmpeg/commit/bf1b838f2a
- Source archive: https://github.com/FFmpeg/FFmpeg/archive/bf1b838f2a.tar.gz
- The supplier's README lists the build configuration and external library versions. Preserve it along with the GPL text when redistributing these binaries.

The application invokes these tools as separate executables; they are not linked into the application binary.
Exact archive and executable checksums are pinned in `tools/ffmpeg.json`.

## Application dependencies

Tauri, its plugins, Lucide, and their dependencies retain their original notices.
The packaging script collects license files from the installed Node packages and
Cargo packages into `licenses/dependencies/`, with an index of names, versions,
license declarations and source locations. Build and test dependencies may also appear in this index.
