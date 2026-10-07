import React, { useState } from "react";
import { Image, type ImageProps } from "expo-image";

const PLACEHOLDER = require("@/assets/images/sermon-placeholder.png");

type Props = Omit<ImageProps, "source" | "placeholder" | "onError"> & {
  uri: string;
};

/** View-size decoding and cached requests; failures remain usable offline. */
export function RemoteImage({ uri, ...props }: Props) {
  const [failedUri, setFailedUri] = useState<string | null>(null);
  return (
    <Image
      cachePolicy="memory-disk"
      allowDownscaling
      contentFit="cover"
      {...props}
      source={failedUri === uri ? PLACEHOLDER : { uri }}
      placeholder={PLACEHOLDER}
      onError={() => setFailedUri(uri)}
    />
  );
}
