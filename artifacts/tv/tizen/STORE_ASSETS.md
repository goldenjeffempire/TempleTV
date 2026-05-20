# Samsung Tizen Smart TV — Store Assets Guide

## Required Assets (Samsung Seller Office)

| Asset | Size | Format | Notes |
|-------|------|--------|-------|
| App icon | 512×423 | PNG | Transparent background |
| Icon (focused) | 512×423 | PNG | Highlighted state |
| Detail icon | 960×540 | PNG | Shown in app detail page |
| Seller logo | 200×200 | PNG | Company logo |
| Screenshots | 1920×1080 | PNG/JPG | Min 4 screenshots |
| Preview video | 1920×1080 | MP4 | 15–60 sec trailer (optional) |

## Icon placement in tizen/

```
artifacts/tv/tizen/
├── config.xml
├── icon.png          # 512×423 — main launcher icon
├── icon_focus.png    # 512×423 — focused/highlighted state
├── logo.png          # 960×540 — app detail page
└── build.sh
```

## Submission Steps

1. Install [Tizen Studio](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html)
2. Generate an author certificate in Tizen Certificate Manager
3. Register your certificate with Samsung Seller Office to get your Package ID
4. Replace `JCTMTV001` in `config.xml` with the Package ID from Samsung
5. Run `bash artifacts/tv/tizen/build.sh`
6. Upload `TempleTv.wgt` to [Samsung Seller Office](https://seller.samsungapps.com)
7. Fill in app metadata, content rating, and distribution regions
8. Submit for Samsung certification review

## Certification Checklist

- [ ] Remote navigation (D-pad) works on all screens
- [ ] Back/Return button exits to home or previous screen
- [ ] Play/Pause/FF/Rewind media keys work during playback
- [ ] App handles suspend/resume correctly
- [ ] No crashes on 2018+ Samsung TV models
- [ ] Audio plays correctly (no echo/double audio)
- [ ] App icon matches Samsung visual guidelines
- [ ] Privacy policy URL provided
- [ ] Content rating completed (usually TV-G or TV-PG for religious content)
