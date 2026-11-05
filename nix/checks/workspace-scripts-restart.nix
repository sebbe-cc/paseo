{ pkgs, paseo }:
pkgs.runCommand "workspace-scripts-restart-check" {
  nativeBuildInputs = [ pkgs.nodejs_22 pkgs.git pkgs.bash pkgs.coreutils pkgs.procps ];
} ''
  export HOME="$TMPDIR/home"
  mkdir -p "$HOME"
  ${pkgs.nodejs_22}/bin/node ${./workspace-scripts-restart.mjs} ${paseo}/bin/paseo ${pkgs.bash}/bin/bash > "$out"
''
