# LG webOS Smart TV — Store Assets Guide

## Required Assets (LG Seller Lounge)

| Asset | Size | Format | Notes |
|-------|------|--------|-------|
| App icon | 80×80 | PNG | Launcher icon |
| Large icon | 130×130 | PNG | App detail |
| Splash screen | 1920×1080 | PNG | Loading screen |
| Screenshots | 1280×720 | PNG | Min 3 screenshots |
| Promotional banner | 960×540 | PNG | Featured placement |

## Icon placement in lg/

```
artifacts/tv/lg/
├── appinfo.json
├── ares-setup-device.json
├── icon.png          # 80×80
├── icon_large.png    # 130×130
├── splash.png        # 1920×1080
└── build.sh
```

## Submission Steps

1. Install webOS CLI: `npm install -g @webosose/ares-cli`
2. Set up your TV device: `ares-setup-device` (follow prompts)
3. Enable developer mode on your LG TV (Settings → Software Information → press the number combination shown on screen)
4. Run `bash artifacts/tv/lg/build.sh`
5. Test on device: `ares-install -d tv-dev com.templetv.jctm_1.0.0_all.ipk`
6. Submit to [LG Seller Lounge](https://seller.lgappstv.com)

## Certification Checklist

- [ ] Remote navigation works on all screens
- [ ] Magic Remote pointer works (click events)
- [ ] Back button returns to correct screen
- [ ] Playback starts within 3 seconds
- [ ] No memory leaks during extended playback
- [ ] App exits cleanly on back-press from home screen
- [ ] Tested on webOS 4, 5, 6, and 22/23 firmware
- [ ] Privacy policy URL provided
