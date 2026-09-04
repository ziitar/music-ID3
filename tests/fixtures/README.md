# Audio Fixtures

Unit tests generate a valid one-second PCM WAV in a temporary directory. The
`library` directory contains compact media fixtures for Electron E2E coverage:

- `editable.Mp3`: tagged MP3 used for metadata writes.
- `album/disc.WaV`: generated PCM WAV associated with `valid.CuE`.
- `fixture.FlAc`, `fixture.m4A`, `fixture.OgG`, `fixture.oPuS`, and `fixture.ApE`:
  copied from the `node-taglib-sharp` upstream test fixtures.
- `fixture.MP4`: generated one-second AAC/MP4 file.
- `fixture.Wv`: generated WavPack file. The scanner must discover it, but the
  installed `node-taglib-sharp` version reports WavPack as unsupported.
- `long-unassociated.MP3`: silent 901-second MP3 used for whole-track detection.

Mixed-case extensions exercise case-insensitive format discovery. E2E tests
copy the directory before making any edits.
