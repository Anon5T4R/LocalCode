# Extension System (spec)

LocalCode supports extensions that contribute panels, language support, commands, and themes.

## Manifest format (`extension.json`)

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
        "entry": "./panel.js",
        "icon": null
      }
    ],
    "languages": [
      {
        "id": "my-lang",
        "extensions": [".foo", ".bar"],
        "monacoLanguage": "plaintext",
        "lsp": {
          "languageId": "my-lang",
          "command": "mylsp",
          "args": ["--stdio"]
        }
      }
    ],
    "commands": [
      {
        "id": "panel:toggle:my-panel",
        "title": "Toggle My Panel",
        "keybindings": ["ctrl+shift+m"]
      }
    ],
    "themes": [
      {
        "name": "My Dark Theme",
        "type": "dark",
        "colors": {
          "--bg-primary": "#1a1a2e",
          "--accent": "#e94560"
        }
      }
    ]
  }
}
```

## Panel API

Extension panels are React components exported as default from the entry file:

```tsx
export default function MyPanel() {
  return <div>Hello from extension!</div>;
}
```

## Extension locations

- **User global**: `%APPDATA%/LocalCode/extensions/<name>/` (Windows)
- **Workspace**: `.localcode/extensions/<name>/` in the project root

Entries in `contributes.panels[].entry` are relative to the extension directory.

## Language registration

Extension languages are merged with built-in languages. Extensions **cannot override** built-in entries. If a built-in entry exists for the same file extension, the built-in takes precedence.

## Theme override

Extension themes set CSS custom properties on `:root`. Multiple themes can be loaded; later themes override earlier ones.
