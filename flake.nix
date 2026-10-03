{
  description = "fleetx: keep every machine you run T3 Code on equivalent";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      # Updated by each release (see .github/workflows/release.yml).
      release = builtins.fromJSON (builtins.readFile ./nix/release.json);
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (pkgs: rec {
        fleetx = pkgs.stdenvNoCC.mkDerivation {
          pname = "fleetx";
          inherit (release) version;
          src = pkgs.fetchurl {
            url = "https://github.com/MartinPTielemans/fleetx/releases/download/v${release.version}/fleetx.mjs";
            inherit (release) hash;
          };
          dontUnpack = true;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          installPhase = ''
            install -Dm644 $src $out/libexec/fleetx.mjs
            makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/fleetx --add-flags $out/libexec/fleetx.mjs
          '';
          meta = {
            description = "Keep every machine you run T3 Code on equivalent";
            homepage = "https://github.com/MartinPTielemans/fleetx";
            license = pkgs.lib.licenses.mit;
            mainProgram = "fleetx";
          };
        };
        default = fleetx;
      });
    };
}
