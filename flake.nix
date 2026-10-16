{
  description = "sintfoap: sintfoap.xyz from the terminal (the CLI/TUI in ./cli)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      # Name, version and dependencies come from cli/pyproject.toml, so the two stay in sync.
      project = (builtins.fromTOML (builtins.readFile ./cli/pyproject.toml)).project;
    in
    {
      packages = forAllSystems (pkgs: rec {
        sintfoap = pkgs.python3Packages.buildPythonApplication {
          pname = project.name;
          inherit (project) version;
          pyproject = true;
          src = ./cli;

          build-system = [ pkgs.python3Packages.setuptools ];
          dependencies = [ pkgs.python3Packages.textual ];

          nativeCheckInputs = [ pkgs.python3Packages.pytestCheckHook ];
          pythonImportsCheck = [ "sintfoap" ];

          meta = {
            inherit (project) description;
            homepage = "https://sintfoap.xyz";
            mainProgram = "sintfoap";
          };
        };
        default = sintfoap;
      });

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = nixpkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            (pkgs.python3.withPackages (ps: [ ps.textual ps.pytest ps.setuptools ]))
          ];
          shellHook = ''
            export PYTHONPATH="$PWD/cli''${PYTHONPATH:+:$PYTHONPATH}"
          '';
        };
      });
    };
}
