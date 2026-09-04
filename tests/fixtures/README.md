# Audio Fixtures

The TagLib test fixture is generated as a valid one-second PCM WAV file in the test's temporary directory. This keeps binary audio out of source control while exercising the real `node-taglib-sharp` read/write path.
