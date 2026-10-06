# Third-party notices

Xavier's own code is MIT (see [LICENSE](LICENSE)). It depends on or bundles the
third-party components below. Reproduce these notices when redistributing.

This file covers three groups:

1. Bundled assets: the fonts and the xterm.js bundle.
2. The npm dependency set of the app in `app/`.
3. The Python dependency set of the server in `server/`.

## Summary

- There are no GPL, AGPL, or LGPL components in the dependency tree.
- Every npm package is under a permissive license (MIT, ISC, BSD-2-Clause,
  BSD-3-Clause, Apache-2.0, 0BSD, Unlicense, BlueOak-1.0.0, Python-2.0, or
  CC0-1.0), with three exceptions called out below: lightningcss (MPL-2.0),
  caniuse-lite (CC-BY-4.0), and node-forge (BSD-3-Clause OR GPL-2.0).
- Every Python package installed in the server image is under a permissive
  license. The one MPL-2.0 package in the server's environment, certifi, is a
  test-only dependency and is not installed in the image.

## Bundled assets

### xterm.js (MIT)

`app/src/terminal/xtermBundle.gen.ts` embeds a generated bundle of
**@xterm/xterm** 6.0.0 and **@xterm/addon-fit** 0.11.0 (xtermjs/xterm.js), plus
the xterm stylesheet. The generated constants record the exact versions, and a
test in `app/src/terminal` pins the two together.

@xterm/xterm:

```
Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)
```

@xterm/addon-fit:

```
Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
```

Both under the same MIT terms:

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### JetBrains Mono (SIL Open Font License 1.1)

The UI monospace font ("HubMono") is **JetBrains Mono**, instanced to static
weights and renamed. It ships as `app/assets/fonts/HubMono-*.ttf`, and its 400
weight is also embedded as base64 in the terminal bundle. Upstream declares no
Reserved Font Name, so the rename needs none of the RFN steps.

```
Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)
Licensed under the SIL Open Font License, Version 1.1. Full text: app/assets/fonts/OFL-JetBrainsMono.txt
```

### Onest (SIL Open Font License 1.1)

The UI sans font ("HubOnest") is **Onest**, copyright The Onest Project Authors
(https://github.com/simpals/onest), under OFL-1.1. It ships as
`app/assets/fonts/HubOnest-*.ttf`; the full license text is in
`app/assets/fonts/OFL-Onest.txt`.

The static files were instanced from the npm package `@fontsource-variable/onest`
by `app/scripts/instance-fonts.py` (HubMono likewise from
`@fontsource-variable/jetbrains-mono`). Instancing is a modification of the font
data, which OFL-1.1 permits. If upstream ever declared a Reserved
Font Name, the renamed "HubOnest" build would need to drop it, so check the
upstream license file when updating the package.

## npm dependencies (`app/`)

The declared dependencies are listed in `app/package.json`. At the time of
writing every declared package is MIT except TypeScript (Apache-2.0). With their
transitive dependencies, several hundred packages are installed under
`app/node_modules`; the license list in the summary above covers all of them.
Regenerate the picture after any dependency change (see the end of this
section).

**Store builds carry these notices too.** An iOS build ships a JavaScript bundle
and compiled native code that contain substantial portions of many of these
packages (React Native, Expo modules, and the rest), and the MIT, BSD and ISC
licenses ask that their copyright and permission notices travel with such
copies. If you distribute a build, include an acknowledgements file or screen
with those notices; a license-report tool can generate it from `app/`.

### Exceptions to the permissive-default picture

These are the only npm packages whose license needs individual attention. None
of them prevents redistribution.

**lightningcss (MPL-2.0)** and its platform binaries (for example
`lightningcss-linux-x64-gnu`). MPL-2.0 is weak, file-level copyleft: if you
modify the library's own source files, those modifications must stay MPL-2.0,
but the rest of the app is unaffected. It is build tooling (CSS processing), not
app runtime code.

**caniuse-lite (CC-BY-4.0)**. Browser compatibility data used by the Babel and
browserslist toolchain. CC-BY-4.0 requires attribution when the data is
redistributed; it is a build-time input, not app runtime code.

**node-forge (BSD-3-Clause OR GPL-2.0)**. Dual licensed; this project elects the
BSD-3-Clause option, which keeps the tree free of copyleft. It is used by the
Expo command-line tooling, not bundled into the app.

Also, for completeness rather than concern:

- `type-fest` (one version) is MIT OR CC0-1.0; either option is permissive.
- `fb-dotslash` is MIT OR Apache-2.0; either option is permissive.
- `@expo-google-fonts/material-symbols` is MIT AND Apache-2.0; both apply.
- `argparse` is under the Python-2.0 license, a permissive license.

### Regenerating the npm enumeration

From `app/`, after `npm install`, list license frequencies with:

```
for d in node_modules/*/ node_modules/@*/*/; do
  node -p "require('./${d%/}/package.json').license ?? 'UNKNOWN'"
done | sort | uniq -c | sort -rn
```

or use any license-report tool (for example `license-checker`) against
`app/package.json`.

## Python server dependencies (`server/`)

The server image installs `server/requirements.txt` and nothing else (see
`server/Dockerfile`), so it contains the packages below marked "image": those
requirements and what they pull in, at whatever versions their ranges allow at
build time. The packages marked "test only" come from
`server/requirements-dev.txt` and exist only in a local test environment.

| Package | License | Where |
| --- | --- | --- |
| annotated-doc | MIT | image |
| annotated-types | MIT | image |
| anyio | MIT | image |
| cbor2 | MIT | image |
| cffi | MIT-0 | image |
| click | BSD-3-Clause | image |
| cryptography | Apache-2.0 OR BSD-3-Clause | image |
| fastapi | MIT | image |
| h11 | MIT | image |
| httptools | MIT | image |
| idna | BSD-3-Clause | image |
| opentelemetry-api | Apache-2.0 | image (pulled in by FastAPI; the API package alone exports nothing) |
| pyasn1 | BSD-2-Clause | image |
| pyasn1_modules | BSD | image |
| pycparser | BSD-3-Clause | image |
| pydantic | MIT | image |
| pydantic_core | MIT | image |
| pyOpenSSL | Apache-2.0 | image |
| python-dotenv | BSD-3-Clause | image |
| PyYAML | MIT | image |
| starlette | BSD-3-Clause | image |
| typing_extensions | PSF-2.0 | image |
| typing-inspection | MIT | image |
| tzdata | Apache-2.0 | image |
| uvicorn | BSD-3-Clause | image |
| uvloop | MIT OR Apache-2.0 | image |
| watchfiles | MIT | image |
| webauthn | BSD-3-Clause | image |
| websockets | BSD-3-Clause | image |
| certifi | MPL-2.0 | test only |
| httpcore | BSD-3-Clause | test only |
| httpx | BSD-3-Clause | test only |
| iniconfig | MIT | test only |
| packaging | Apache-2.0 OR BSD-2-Clause | test only |
| pluggy | MIT | test only |
| Pygments | BSD-2-Clause | test only |
| pytest | MIT | test only |

This list was taken from a local environment built from both requirements files
in October 2026. The base image (`python:3.12-slim`) brings its own Python,
Debian packages and pip, each under its own license.

### certifi is MPL-2.0

**certifi** (the CA certificate bundle used by the HTTP test client) is licensed
under the Mozilla Public License 2.0: weak, file-level copyleft whose notice must
be preserved, without affecting the license of anything that merely uses it. It
is installed only for the tests, not in the server image.

### Dual licenses (permissive options taken)

- **cryptography**: Apache-2.0 OR BSD-3-Clause; the BSD-3-Clause option is
  elected for notice purposes.
- **packaging**: Apache-2.0 OR BSD-2-Clause; either option is permissive.
- **uvloop**: MIT OR Apache-2.0; either option is permissive.
- **cffi**: MIT-0 (an MIT variant with no attribution requirement).

No Python package in the tree is GPL, AGPL, or LGPL.
