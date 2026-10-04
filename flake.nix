{
  description = "T3 Fleet: keep every machine you run T3 Code on equivalent";

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
        t3-fleet = pkgs.stdenvNoCC.mkDerivation {
          pname = "t3-fleet";
          inherit (release) version;
          src = pkgs.fetchurl {
            url = "https://github.com/MartinPTielemans/fleetx/releases/download/v${release.version}/t3-fleet.mjs";
            inherit (release) hash;
          };
          dontUnpack = true;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          installPhase = ''
            install -Dm644 $src $out/libexec/t3-fleet.mjs
            makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/t3-fleet --add-flags $out/libexec/t3-fleet.mjs
          '';
          meta = {
            description = "Keep every machine you run T3 Code on equivalent";
            homepage = "https://github.com/MartinPTielemans/fleetx";
            license = pkgs.lib.licenses.mit;
            mainProgram = "t3-fleet";
          };
        };
        default = t3-fleet;
      });
    };
}
