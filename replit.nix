{pkgs}: {
  deps = [
    pkgs.jdk
    pkgs.ffmpeg
    pkgs.minio-client
    pkgs.minio
  ];
}
