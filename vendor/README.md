# Optional terminal QR renderer

`qrcode-8.2-py3-none-any.whl` is an unmodified wheel from official PyPI. It is loaded only by the temporary Weixin interactive test's terminal renderer; it does not install into Python or require Pillow/pypng. SHA256: `16e64e0716c14960108e85d853062c9e8bba5ca8252c0b4d0231b9df4060ff4f`.

See `qrcode-8.2-source.json` for the download URL and `qrcode-8.2-LICENSE` (also embedded in the wheel) for BSD-3-Clause and the original QR algorithm MIT attribution. No install scripts are executed.

The Weixin login protocol was independently implemented from Tencent/openclaw-weixin commit `874637a0dbc24050f72d1385add4fc6170a2d726`, `src/auth/login-qr.ts` and `docs/protocol.md`. Its existing MIT notice is in ../licenses/. No upstream Agent framework is bundled.
