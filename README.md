# WebR kernel for JupyterLite

This repository contains a JupyterLite kernel that uses [webR](https://github.com/r-wasm/webR) to execute R code. When the kernel is started, the webR WebAssembly binaries are downloaded from CDN and loaded into the page.

## Demonstration instance

A demo instance of JupyterLite including the webR kernel and a sample Jupyter notebook containing R code can be found at <https://jupyter.r-wasm.org>.

## Install

This package is not yet available on PyPI. You can install it from GitHub:

```bash
pip install git+https://github.com/r-wasm/jupyterlite-webr-kernel.git
```

or from a local clone:

```bash
git clone https://github.com/r-wasm/jupyterlite-webr-kernel
cd jupyterlite-webr-kernel
pip install .
```

Then build your JupyterLite site:

```bash
jupyter lite build
```

## Configuration

The file `jypyter-lite.json` may be modified to set the webR base URL `baseUrl` and default package repository `repoUrl`. For example:

```json
{
  "jupyter-lite-schema-version": 0,
  "jupyter-config-data": {
    "litePluginSettings": {
      "@r-wasm/webr-kernel-extension:kernel": {
        "baseUrl": "https://webr.r-wasm.org/latest/",
        "repoUrl": "https://repo.r-wasm.org/"
      }
    }
  }
}
```

See the Jupyterlite documentation on [configuration files](https://jupyterlite.readthedocs.io/en/latest/howto/configure/config_files.html#jupyter-lite-json) for more information.

## Limitations

### Headers

To use the webR kernel with JupyterLite, the page must be served with certain security-related HTTP headers so that it is cross-origin isolated. By setting these headers webR's `SharedArrayBuffer` based communication channel can be used:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### Virtual file system storage

Due to limitations in the way the webR worker thread is implemented, the persistent JupyterLite file storage and the Emscripten VFS used by webR are not accessible to one another. The simplest way to import data into a webR notebook at the time of writing is by using R functions such as `read.csv()` with a publicly accessible URL.

### Interruption

While webR supports interrupting long running computations, interrupting cell execution has not yet been implemented in JupyterLite. An infinite looping cell can only be recovered by restarting the kernel.

## Contributing

### Development install

Note: You will need NodeJS and Python 3.9+ to build the extension package. There is an environment.yml file for conda/mamba/micromamba users to create a conda environment with the required dependencies.

The `jlpm` command is JupyterLab's pinned version of [yarn](https://yarnpkg.com/) that is installed with JupyterLab. You may use `yarn` or `npm` in lieu of `jlpm` below.

```bash
# Clone the repo to your local environment
# Change directory to the jupyterlite-webr-kernel directory
# Install package in development mode
python -m pip install -e ".[dev]"

# Link your development version of the extension with JupyterLab
jupyter labextension develop . --overwrite

# Rebuild extension Typescript source after making changes
jlpm run build

# Rebuild JupyterLite after making changes
jupyter lite clean && jupyter lite build
```

To serve the extension with the JupyterLite server, you will need to set the required HTTP headers. The `config.json` file in this repository contains the required headers. You can start the JupyterLite server with the following command:

```bash
jupyter lite serve --config=config.json
```

Note that making changes to the extension will not automatically re-install the extension in the JupyterLite server. You will need to re-build and restart the server to see changes in the extension.

```shell
jupyter lite clean && jupyter lite build && jupyter lite serve --config=config.json
```

### Development uninstall

```bash
pip uninstall jupyterlite-webr-kernel
```

In development mode, you will also need to remove the symlink created by `jupyter labextension develop` command. To find its location, you can run `jupyter labextension list` to figure out where the `labextensions` folder is located. Then you can remove the symlink named `jupyterlite-webr-kernel` within that folder.
