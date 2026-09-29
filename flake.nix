{
  description = "Paseo - self-hosted daemon for AI coding agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    {
      self,
      nixpkgs,
    }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      pkgsFor = system: import nixpkgs { inherit system; };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          # The fork reports 0.9.2+desvio.<commit> so the running build is identifiable.
          paseo = pkgs.callPackage ./nix/package.nix {
            buildMetadata = "desvio.${self.shortRev or self.dirtyShortRev or "unknown"}";
          };
          versionParts = pkgs.lib.splitString "." paseo.version;
          sourceRevision = if self ? revCount && self.revCount != null then self.revCount else 0;
          buildRevision = sourceRevision - (sourceRevision / 10000) * 10000;
          desktopBuildVersion = pkgs.lib.concatStringsSep "." [
            (builtins.elemAt versionParts 0)
            (builtins.elemAt versionParts 1)
            (toString buildRevision)
          ];
        in
        {
          default = paseo;
          paseo = paseo;
          desktop = pkgs.callPackage ./nix/desktop-package.nix {
            inherit paseo;
            buildVersion = desktopBuildVersion;
          };
        }
        // pkgs.lib.optionalAttrs (system == "aarch64-darwin") (
          let
            # Gradient evaluates a path: archive without rev, so only desktop-release reads it.
            rev = self.shortRev or (throw "desktop-release needs a github:sebbe-cc/paseo/<sha> ref");
            date = self.lastModifiedDate;
          in
          {
            # Gradient builds and caches this; publish-mac turns it into the signed release on tempus.
            desktop-release-build = pkgs.callPackage ./nix/desktop-release-build.nix {
              desktop = self.packages.${system}.desktop;
            };
            desktop-release = pkgs.callPackage ./nix/desktop-release.nix {
              desktop = self.packages.${system}.desktop;
              releaseBuild = self.packages.${system}.desktop-release-build;
              buildVersion = paseo.version;
              buildMetadata = "desvio.${rev}";
              releaseVersion = "${paseo.version}-desvio.${date}.${rev}";
            };
          }
        )
      );

      nixosModules.default = self.nixosModules.paseo;
      nixosModules.paseo =
        { pkgs, lib, ... }:
        {
          imports = [ ./nix/module.nix ];
          services.paseo.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_22
              pkgs.python3
            ];
          };
        }
      );
    };
}
