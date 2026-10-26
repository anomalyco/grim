# Fonts

Static Inter 4.1 TTFs from the official release
(https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip, `extras/ttf/`).

| File | Weight | Style |
| --- | --- | --- |
| `Inter-Regular.ttf` | 400 | normal |
| `Inter-Italic.ttf` | 400 | italic |
| `Inter-Medium.ttf` | 500 | normal |
| `Inter-SemiBold.ttf` | 600 | normal |
| `Inter-Bold.ttf` | 700 | normal |
| `Inter-BoldItalic.ttf` | 700 | italic |

All files are family "Inter". Pass them to Rune via `AppSpec::fonts` (which replaces the
embedded Regular/Medium/SemiBold Inter), e.g.

```rust
static FONTS: &[&[u8]] = &[
    include_bytes!("../assets/fonts/Inter-Regular.ttf"),
    include_bytes!("../assets/fonts/Inter-Italic.ttf"),
    include_bytes!("../assets/fonts/Inter-Medium.ttf"),
    include_bytes!("../assets/fonts/Inter-SemiBold.ttf"),
    include_bytes!("../assets/fonts/Inter-Bold.ttf"),
    include_bytes!("../assets/fonts/Inter-BoldItalic.ttf"),
];
```

Italic only renders once Rune's `Span` gets an italic flag (see `docs/rune-capabilities.md`).

## License

Inter is © The Inter Project Authors, licensed under the SIL Open Font License 1.1.
See `Inter-LICENSE.txt`.
