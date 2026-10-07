{
  description = "digital_aquarium - browser aquarium + reproducible fish-sprite tooling";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f (import nixpkgs { inherit system; }));
      pythonEnv = pkgs: pkgs.python3.withPackages (ps: [ ps.opencv4 ps.numpy ps.pillow ]);
    in
    {
      packages = forAllSystems (pkgs:
        let
          process-fish = pkgs.writeShellApplication {
            name = "process-fish";
            runtimeInputs = [ (pythonEnv pkgs) ];
            text = ''exec python ${./tools/process_fish.py} "$@"'';
          };
        in
        {
          default = process-fish;
          inherit process-fish;
        });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [ (pythonEnv pkgs) pkgs.ruff ];
          shellHook = ''
            echo "digital_aquarium dev shell"
            echo "  process-fish scans/ -o out        # image(s) -> transparent fish PNGs"
          '';
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixpkgs-fmt);
    };
}
