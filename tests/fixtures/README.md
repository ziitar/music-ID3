# Audio Fixtures

Unit tests generate a valid one-second PCM WAV in a temporary directory. The
`library` directory contains compact media fixtures for Electron E2E coverage:
a tagged MP3, a CUE-associated WAV, and a silent 901-second MP3 used to exercise
whole-track detection. E2E tests copy the directory before making any edits.
