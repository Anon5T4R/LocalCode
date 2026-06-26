# Tutorial: Creating an Extension

This guide walks through creating a LocalCode extension.

## Prerequisites

- LocalCode v0.4.9+
- Node.js 18+ (for building extension panels)
- Basic knowledge of React and TypeScript

## Step 1: Create the directory structure

```
.localcode/extensions/my-extension/
├── extension.json
├── panel.js          # compiled React component
└── package.json      # (optional) for tooling
```

For extensions with React components, create a build setup:

### `package.json`
```json
{
  "name": "my-extension",
  "private": true,
  "scripts": {
    "build": "esbuild panel.tsx --bundle --outfile=panel.js --external:react --external:react-dom --format=esm"
  },
  "devDependencies": {
    "esbuild": "^0.24.0"
  }
}
```

## Step 2: Write the panel component

### `panel.tsx`
```tsx
import React from "react";

export default function MyPanel() {
  return (
    <div style={{ padding: 12 }}>
      <h3>My Extension</h3>
      <p>Hello from the extension!</p>
    </div>
  );
}
```

Run `npm run build` to compile it to `panel.js`.

## Step 3: Write the manifest

### `extension.json`
```json
{
  "name": "my-extension",
  "version": "1.0.0",
  "displayName": "My Extension",
  "contributes": {
    "panels": [
      {
        "id": "my-panel",
        "title": "My Panel",
        "location": "side-panel",
        "entry": "./panel.js"
      }
    ],
    "commands": [
      {
        "id": "panel:toggle:my-panel",
        "title": "Toggle My Panel",
        "keybindings": ["ctrl+shift+y"]
      }
    ]
  }
}
```

## Step 4: Register the panel in App.tsx

No need — extensions are auto-detected on startup. The command `ctrl+shift+y` will toggle the side panel visibility.

## Adding custom languages

To add syntax highlighting for a custom file extension:

```json
{
  "contributes": {
    "languages": [
      {
        "id": "my-lang",
        "extensions": [".mylang"],
        "monacoLanguage": "plaintext"
      }
    ]
  }
}
```

To also add LSP support:

```json
{
  "contributes": {
    "languages": [
      {
        "id": "my-lang",
        "extensions": [".mylang"],
        "monacoLanguage": "plaintext",
        "lsp": {
          "languageId": "mylang",
          "command": "my-language-server",
          "args": ["--stdio"]
        }
      }
    ]
  }
}
```

## Command IDs

| Pattern | Description |
|---|---|
| `panel:toggle:<panel-id>` | Toggles visibility of a side panel |
| `panel:show:<panel-id>` | Shows a side panel |
| `panel:hide:<panel-id>` | Hides a side panel |

## Theming

Extensions can override any CSS custom property:

```json
{
  "contributes": {
    "themes": [
      {
        "name": "Solarized Dark",
        "type": "dark",
        "colors": {
          "--bg-primary": "#002b36",
          "--bg-secondary": "#073642",
          "--bg-tertiary": "#073642",
          "--text-primary": "#839496",
          "--text-secondary": "#93a1a1",
          "--accent": "#268bd2",
          "--border": "#094350"
        }
      }
    ]
  }
}
```

## Troubleshooting

- **Panel not showing**: Check `ctrl+shift+<your-keybinding>` or open from devtools. Verify `extension.json` is valid JSON.
- **Component not loading**: Ensure the `entry` path is correct (relative to extension dir). Check the console for import errors.
- **LSP not starting**: Verify the `command` is on `$PATH` and `args` are correct.
- **Language not highlighting**: Monaco must support the `monacoLanguage` value, or use `"plaintext"`.
