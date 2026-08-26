# Xcode Integration

## Add to the iOS target

Add every `.swift` file in this folder to your app target.

Link:

```text
libsqlite3.tbd
```

Bundle:

```text
hawza_knowledge.sqlite
```

from:

```text
knowledge/output/hawza_knowledge.sqlite
```

The database must appear in **Copy Bundle Resources**.

## Replace the WebView

Use:

```swift
HawzaChatView()
```

instead of the `WKWebView` that loads the ChatGPT Custom GPT URL.

## Deployment

Compile with an Xcode/SDK version that contains Apple's `FoundationModels` framework.

The service checks `SystemLanguageModel.default.availability` before generating.

If unavailable, the strict zero-cost design returns a local-model-unavailable error rather than calling a paid API.
