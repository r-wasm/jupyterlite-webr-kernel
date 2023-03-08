# WebR kernel for JupyterLite

This repository contains a JupyterLite kernel that uses [webR](https://github.com/r-wasm/webR) to execute R code. When the kernel is started, the webR WebAssembly binaries are downloaded from CDN and loaded into the page.

## Demonstration instance
A demo instance of JupyterLite including the webR kernel and a sample Jupyter notebook containing R code can be found at <https://jupyter.r-wasm.org>.

## Limitations

### Virtual file system storage

Due to limitations in the way the webR worker thread is implemented, the persistent JupyterLite file storage and the Emscripten VFS used by webR are not accessible to one another. The simplest way to import data into a webR notebook at the time of writing is by using R functions such as `read.csv()` with a publicly accessible URL.

### Interruption

While webR supports interrupting long running computations, interrupting cell execution has not yet been implemented in JupyterLite. An infinite looping cell can only be recovered by restarting the kernel.

## WebR for JupyterLite development setup

The following is an example set of instructions for Unix-like environments such as running under Linux or macOS.

First, setup a fresh version of JupyterLite in a new virtual environment:

* Create a new directory for JupyterLite (e.g. `jupyter`) and `cd` into it in a
  terminal.
* Create a new virtual env, `python -m venv jupyterlite-venv`
* Activate it, `. ./jupyterlite-venv/bin/activate`
* Install JupyterLite, `pip install jupyterlab jupyterlite jupyter_packaging`

In order to use the webR kernel with JupyterLite the page must be served with certain security-related HTTP headers, so that it is is cross-origin isolated. By setting these headers webR's `SharedArrayBuffer` based communication channel can be used.

If you are using an external web server, configure the web server to serve JupyterLite with the HTTP following headers set,

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

If you are planning to use the built in JupyterLite server, create the file `config.json` with the following contents, which sets up the local development server to include the required HTTP headers.

```
{
  "LiteBuildConfig": {
    "extra_http_headers": {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    }
  }
}
```

Next, clone the webR JupyterLite kernel repository, change directory into it, and build the kernel,

 * `git clone [...]`
 * `cd jupyterlite-webr-kernel`
 * `npm install`
 * `yarn build`
 * `python setup.py sdist`

Return to the previous directory, install the webR kernel, and build JupyterLite,

 * `cd -`
 * `pip install jupyterlite-webr-kernel/dist/jupyterlite-webr-*.tar.gz`
 * `jupyter lite clean`
 * `jupyter lite build --config=config.json`

The resulting JupyterLite website is built in the output directory, `_output`.

If you are using the built in server, be sure to start the server with the `--config` argument. For example,

* `jupyter lite serve --config=config.json --port 8888`

and then visit `http://127.0.0.1:8888` in a browser to load JupyterLite.
