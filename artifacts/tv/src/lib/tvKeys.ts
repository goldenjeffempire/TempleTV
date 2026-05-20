export type TVAction =
  | "up" | "down" | "left" | "right"
  | "select" | "back"
  | "play" | "pause" | "playpause"
  | "fastforward" | "rewind" | "stop"
  | "red" | "green" | "yellow" | "blue"
  | "info" | "menu" | "exit";

const KEY_NAME_MAP: Record<string, TVAction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Enter: "select",
  " ": "playpause",
  Backspace: "back",
  Escape: "back",
  GoBack: "back",
  XF86Back: "back",
  MediaPlay: "play",
  MediaPause: "pause",
  MediaPlayPause: "playpause",
  MediaFastForward: "fastforward",
  MediaRewind: "rewind",
  MediaStop: "stop",
  MediaTrackNext: "fastforward",
  MediaTrackPrevious: "rewind",
  ColorF0Red: "red",
  ColorF1Green: "green",
  ColorF2Yellow: "yellow",
  ColorF3Blue: "blue",
  Info: "info",
  Menu: "menu",
  XF86AudioPlay: "play",
  XF86AudioPause: "pause",
  XF86AudioStop: "stop",
  XF86AudioRaiseVolume: "fastforward",
  XF86AudioLowerVolume: "rewind",
};

const KEY_CODE_MAP: Record<number, TVAction> = {
  37: "left",
  38: "up",
  39: "right",
  40: "down",
  13: "select",
  8: "back",
  27: "back",
  10009: "back",
  461: "back",
  10182: "exit",
  415: "play",
  19: "pause",
  10252: "playpause",
  417: "fastforward",
  412: "rewind",
  413: "stop",
  403: "red",
  404: "green",
  405: "yellow",
  406: "blue",
  457: "info",
  18: "menu",
};

export function keyEventToAction(e: KeyboardEvent): TVAction | null {
  const byName = KEY_NAME_MAP[e.key];
  if (byName) return byName;
  const byCode = KEY_CODE_MAP[e.keyCode ?? e.which];
  if (byCode) return byCode;
  return null;
}

export type { TVAction as default };
