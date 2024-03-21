import { BaseKernel } from '@jupyterlite/kernel';
import { KernelMessage } from '@jupyterlab/services';
import { IKernel } from '@jupyterlite/kernel';

import { Console, WebR, Shelter} from 'webr';
import { RList, RCharacter, RLogical } from 'webr';

const webRVersion = "0.3.0-rc.1";
const baseRVersion = "4.3.3";
const protocolVersion = "5.3";

export class WebRKernel extends BaseKernel {
  webR: WebR;
  shelter!: Shelter;
  init: Promise<void>;
  #webRConsole: Console;
  #bitmapCanvas: HTMLCanvasElement;
  #lastPlot: string | null = null;

  constructor(options: IKernel.IOptions) {
    super(options);
    this.#webRConsole = new Console({
      stdout: (line: string) => console.log(line),
      stderr: (line: string) => console.error(line),
      prompt: (prompt: string) => this.inputRequest({ prompt, password: false }),
    });
    this.webR = this.#webRConsole.webR;
    this.init = this.setupEnvironment();
    this.#bitmapCanvas = document.createElement('canvas');
  }

  async setupEnvironment(): Promise<void> {
    await this.webR.init();
    this.shelter = await new this.webR.Shelter();
    // Enable dev.control to allow active plots to be copied
    await this.webR.evalRVoid(`
      options(device = function(...){
        pdf(...)
        dev.control("enable")
      }, webr.plot.new = FALSE)
    `);
    // Create a signal when there is a new plot to be shown in JupyterLite
    await this.webR.evalRVoid(`
      setHook("grid.newpage", function() {
        options(webr.plot.new = TRUE)
      }, "replace")
      setHook("plot.new", function() {
        options(webr.plot.new = TRUE)
      }, "replace")
    `);
    // Default plot size
    await this.webR.evalRVoid(`
      options(webr.plot.width = 7, webr.plot.height = 5.25)
    `);
    // Install package management shims
    await this.webR.evalRVoid(`
      webr::shim_install()
    `);
  }

  inputReply(content: KernelMessage.IInputReplyMsg['content']): void {
    if (content.status === 'ok') {
      this.#webRConsole.stdin(content.value);
    }
  }

  async kernelInfoRequest(): Promise<KernelMessage.IInfoReplyMsg['content']> {
    await this.init;
    const content: KernelMessage.IInfoReply = {
      status: 'ok',
      protocol_version: protocolVersion,
      implementation: 'webr',
      implementation_version: webRVersion,
      language_info: {
        name: 'R',
        version: baseRVersion,
        mimetype: 'text/x-rsrc',
        file_extension: '.R',
      },
      banner: `webR v${webRVersion} - R v${baseRVersion}`,
      help_links: [
        {
          text: 'WebAssembly R Kernel',
          url: 'https://github.com/r-wasm/jupyterlite-webr-kernel',
        }
      ],
    };
    return content;
  }

  async executeRequest(
    content: KernelMessage.IExecuteRequestMsg['content']
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    await this.init;

    try {
      const exec = await this.shelter.captureR(`
        withVisible({
          eval(parse(text = code), envir = globalenv())
        })
      `, {
        env: { code: content.code },
        captureGraphics: false, // We handle graphics capture, to support incremental plotting
      });
      const output = exec.output as { type: string; data: unknown }[];

      // Deal with showing stream and condition outputs
      output.forEach(async (out) => {
        switch (out.type) {
          case 'stdout':
            this.stream({ name: 'stdout', text: (out.data as string) + '\n' });
            break;
          case 'stderr':
            this.stream({ name: 'stderr', text: (out.data as string) + '\n' });
            break;
          case 'message': {
            const cnd = out.data as RList;
            const message = (await cnd.get('message')) as RCharacter;
            this.stream({
              name: 'stderr',
              text: (await message.toString()) + '\n',
            });
            break;
          }
          case 'warning': {
            const cnd = out.data as RList;
            const message = (await cnd.get('message')) as RCharacter;
            this.stream({
              name: 'stderr',
              text: 'Warning message:\n' + (await message.toString()) + '\n',
            });
            break;
          }
        }
      });

      // Send the result if it's visible
      const visible = await exec.result.get('visible') as RLogical;
      if (await visible.toBoolean()) {
        const value = await exec.result.get('value');
        const exec_result = await this.shelter.evalR(`
          capture.output(print(value))
        `, { env: { value } }) as RCharacter;

        this.publishExecuteResult({
          execution_count: this.executionCount,
          data: {
            'text/plain': [await (await exec_result.toArray()).join('\n')],
          },
          metadata: {}
        });
      }

      // Send an R plot if there are changes to the graphics device
      await this.plotOutput();

      // Send success signal
      return {
        status: 'ok',
        execution_count: this.executionCount,
        user_expressions: {},
      };
    } catch (e) {
      const evalue = (e as { message: string }).message;
      this.stream({ name: 'stderr', text: 'Error: ' + evalue + '\n' });
      return {
        status: 'error',
        execution_count: this.executionCount,
        ename: 'error',
        evalue,
        traceback: [],
      };
    } finally {
      await this.shelter.purge();
    }
  }

  async plotOutput(): Promise<void> {
    const dev = await this.webR.evalRNumber('dev.cur()');
    const newPlot = await this.webR.evalRBoolean('getOption("webr.plot.new")');
    if (dev > 1) {
      const capturePlot = await this.shelter.captureR(`
        try({
          w <- getOption("webr.plot.width")
          h <- getOption("webr.plot.height")
          webr::canvas(width = 72 * w, height = 72 * h, capture = TRUE)
          capture_dev = dev.cur();

          dev.set(${dev})
          dev.copy(which = capture_dev)
          dev.off(capture_dev)
        }, silent = TRUE)
      `);
      const image = capturePlot.images[0];
      this.#bitmapCanvas.width = image.width;
      this.#bitmapCanvas.height = image.height;
      this.#bitmapCanvas.getContext('bitmaprenderer')?.transferFromImageBitmap(image);
      const plotData = this.#bitmapCanvas.toDataURL('image/png');

      if (newPlot || plotData !== this.#lastPlot) {
        this.#lastPlot = plotData;
        this.displayData({
          data: {
            'image/png': plotData.split(",")[1],
            'text/plain': [
              `<Figure of size ${this.#bitmapCanvas.width}x${this.#bitmapCanvas.height}>`
            ]
          },
          metadata: {
            'image/png' : {
              width: 3 * this.#bitmapCanvas.width / 4,
              height: 3 * this.#bitmapCanvas.height / 4,
            }
          },
        });
        await this.webR.evalRVoid('options(webr.plot.new = FALSE)');
      }
    }
  }

  async completeRequest(): Promise<KernelMessage.ICompleteReplyMsg['content']> {
    throw new Error('Unimplemented');
  }

  async inspectRequest(): Promise<KernelMessage.IInspectReplyMsg['content']> {
    throw new Error('Unimplemented');
  }

  async isCompleteRequest(): Promise<KernelMessage.IIsCompleteReplyMsg['content']> {
    throw new Error('Unimplemented');
  }

  async commInfoRequest(): Promise<KernelMessage.ICommInfoReplyMsg['content']> {
    throw new Error('Unimplemented');
  }

  async commOpen(): Promise<void> {
    throw new Error('Unimplemented');
  }

  async commMsg(): Promise<void> {
    throw new Error('Unimplemented');
  }

  async commClose(): Promise<void> {
    throw new Error('Unimplemented');
  }
}
