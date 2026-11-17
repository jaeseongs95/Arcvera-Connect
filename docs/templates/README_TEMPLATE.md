# <Project Display Name> (`<package-name>` `v<MAJOR.MINOR.PATCH>`)

**Languages:** **English ([README.md](./README.md))** | **[한국어 (README.ko.md)](./README.ko.md)**

<One-paragraph formal summary of the software's purpose, supported runtime environments, and core capabilities.>

---

## Table of Contents

1. [Overview & Key Features](#overview--key-features)
2. [Architecture Overview](#architecture-overview)
3. [System Requirements & Compatibility](#system-requirements--compatibility)
4. [Quick Start & Deployment](#quick-start--deployment)
5. [CLI Options & Environment Variables](#cli-options--environment-variables)
6. [Security Model](#security-model)
7. [Repository Structure](#repository-structure)
8. [Verification & Testing](#verification--testing)
9. [License](#license)

---

## Overview & Key Features

- **<Feature 1 Title>**: <Formal technical description.>
- **<Feature 2 Title>**: <Formal technical description.>

---

## Architecture Overview

<Formal architectural diagram and explanation of relay and direct operating modes.>

---

## System Requirements & Compatibility

- **Node.js**: `>= 22.0.0` (Node.js 24 recommended)
- **Supported Runtime Adapters**: `<Supported CLI / App-Server Runtimes>`

---

## Quick Start & Deployment

```bash
git clone https://github.com/<owner>/<repo>.git
cd <repo>
npm ci
npm run build
```

---

## CLI Options & Environment Variables

| CLI Flag | Environment Variable | Default | Description |
| --- | --- | --- | --- |
| `<flag>` | `<ENV_VAR>` | `<default>` | `<Formal description>` |

---

## Security Model

<Formal description of authentication, transport isolation, rate limiting, and resource bounds.>

---

## Repository Structure

```text
<repo>/
├── server/
├── src/
├── scripts/
├── docs/
│   ├── relay-protocol.md
│   └── templates/
│       ├── README_TEMPLATE.md
│       └── RELEASE_NOTES_TEMPLATE.md
├── tests/
├── README.md
├── README.ko.md
├── LICENSE
└── package.json
```

---

## Verification & Testing

```bash
npm ci
npm test
npm run build
npm run test:e2e
```

---

## License

[MIT License](LICENSE)
