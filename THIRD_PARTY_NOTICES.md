# Third-Party Notices

This application contains focused, modified adapter logic learned from the
projects below. It does not vendor or run either project's HTTP server,
framework, routing layer, global configuration, logging, proxy, login, playback,
or deployment code. The provider endpoints are unofficial and may change or
stop working.

## NetEase Cloud Music API Enhanced

- Upstream: https://github.com/neteasecloudmusicapienhanced/api-enhanced
- Reviewed branch and exact commit: `main` at
  `f5ce55bcb46e29c8e5350ca796fb1cc9d9914acd`
- License: MIT
- Upstream notice: the README describes the project as a third-party API with
  no warranty and permits use, modification, redistribution, and commercial use
  under the MIT License.
- Logic reviewed: `module/search.js`, `module/song_detail.js`, `module/album.js`,
  `util/option.js`, `util/request.js`, and `util/config.json`.
- Local extraction/modification: `electron/services/metadata/netease-adapter.ts`
  keeps only the song-search and song-detail form parameters, maps provider JSON
  to the application's metadata contract, derives cover requests from returned
  album image URLs, and injects the encrypted-at-rest Cookie only at request
  time. The upstream server and its encryption/proxy framework are not copied.
- Copyright: Copyright (c) 2013-2022 Binaryify and contributors.

## QQ Music API

- Upstream: https://github.com/Rain120/qq-music-api
- Reviewed branch and exact commit: `next` at
  `d05420bf098bd2769866eba81cfd48a6d0c6f50c`
- License: MIT
- Learning/non-commercial notice: the upstream package description says it is
  "just for study", and its README states that the code is only for learning
  and must not be used commercially. That upstream restriction/warning applies
  to the extracted adapter logic in this application.
- Logic reviewed: `src/services/search/getSearchByKey.ts`,
  `src/controllers/getSongInfo.ts`, `src/services/album/getAlbumInfo.ts`,
  `src/controllers/getImageUrl.ts`, `src/services/y_common.ts`,
  `src/services/u_common.ts`, `src/util/request.ts`, and
  `src/config/default.ts`.
- Local extraction/modification: `electron/services/metadata/qqmusic-adapter.ts`
  keeps only search and song-detail query construction, result mapping, and the
  album-cover URL pattern. It injects the encrypted-at-rest Cookie only at
  request time. Koa, controllers, routes, Axios configuration, and server code
  are not copied.
- Copyright: Copyright (c) 2019 Rain120 and contributors.

## MIT License Text

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
