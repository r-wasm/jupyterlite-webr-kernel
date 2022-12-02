# WebR for JupyterLite

This repository contains a JupyterLite kernel for webR. When the kernel is
started, the webR WebAssembly binaries are downloaded from CDN and loaded into
the page.

## WebR for JupyterLite Development Setup

The following is an example set of instructions for Unix-like environments such
as running under Linux or macOS.

First, setup a fresh version of JupyterLite in a new virtual environment:

* Create a new directory for JupyterLite (e.g. `jupyter`) and `cd` into it in a
  terminal.
* Create a new virtual env, `python -m venv jupyterlite-venv`
* Activate it, `. ./jupyterlite-venv/bin/activate`
* Install JupyterLite, `pip install jupyterlab jupyterlite jupyter_packaging`

To be able to use the webR kernel within JupyterLite it must be served with
certain security-related HTTP headers, so that it is is cross-origin isolated.
By setting these headers the webR `SharedArrayBuffer` based communication
channel can be used.

If you are using an external web server, configure the web server to serve
JupyterLite with the HTTP following headers set,

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

If you are planning to use the built in JupyterLite server, create the file
`config.json` with the following contents, which sets up the local development
server to include the required HTTP headers.

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

Next, clone the webR JupyterLite kernel repository, change directory into it,
and build the kernel,
 * `git clone [...]`
 * `cd jupyterlite-webr-kernel`
 * `npm install`
 * `yarn build`
 * `python setup.py sdist`

Return to the previous directory, install the webR kernel, and build
JupyterLite,

 * `cd -`
 * `pip install jupyterlite-webr-kernel/dist/jupyterlite-webr-*.tar.gz`
 * `jupyter lite clean`
 * `jupyter lite build --config=config.json`

The resulting JupyterLite website is built in the output directory, `_output`.

If you are using the built in server, be sure to start the server with the
`--config` argument. For example,

* `jupyter lite serve --config=config.json --port 8888`

and then visit `http://127.0.0.1:8888` in a browser to load JupyterLite.
