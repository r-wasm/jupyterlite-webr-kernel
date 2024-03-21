import { KernelMessage } from '@jupyterlab/services';
import { IKernel } from '@jupyterlite/kernel';
import { ISignal, Signal } from '@lumino/signaling';
import { v4 as uuid } from 'uuid';

import { Console, Shelter, RCharacter, RList, RObject } from 'webr';

export namespace WebRKernel {
  export interface IOptions extends IKernel.IOptions {}
}

const webRVersion = "0.3.0-rc.0";
const baseRVersion = "4.3.3";
const protocolVersion = "5.2";

export class WebRKernel implements IKernel {
  #id: string;
  #name: string;
  #location: string;
  #isDisposed = false;
  #disposed = new Signal<this, void>(this);
  #sendMessage: IKernel.SendMessage;
  #parentHeader: KernelMessage.IHeader<KernelMessage.MessageType> | undefined = undefined;
  #executionCounter = 0;
  #webRConsole: Console;
  #init: Promise<any>;
  #envSetup: Promise<any>;
  #shelter!: Shelter;
  #bitmapCanvas: HTMLCanvasElement;
  #lastRecord: RObject | null = null;

  constructor(options: WebRKernel.IOptions) {
    const { id, name, sendMessage, location } = options;
    this.#id = id;
    this.#name = name;
    this.#location = location;
    this.#sendMessage = sendMessage;
    this.#webRConsole = new Console({
      stdout: (line: string) => console.log(line),
      stderr: (line: string) => console.error(line),
      prompt: (prompt: string) => this.sendStdinRequest({ prompt, password: false }),
    });
    this.sendKernelStatus('starting');
    this.#webRConsole.run();
    this.#init = this.#webRConsole.webR.init();
    this.#envSetup = this.setupEnvironment();
    this.#bitmapCanvas = document.createElement('canvas');
  }

  get id(): string {
    return this.#id;
  }

  get name(): string {
    return this.#name;
  }

  get location(): string {
    return this.#location;
  }

  get ready(): Promise<void> {
    return this.#init;
  }

  get isDisposed(): boolean {
    return this.#isDisposed;
  }

  get disposed(): ISignal<this, void> {
    return this.#disposed;
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.#isDisposed = true;
    this.#disposed.emit(void 0);
  }

  async setupEnvironment(): Promise<void> {
    await this.ready;
    this.#shelter = await new this.#webRConsole.webR.Shelter();
    // Enable dev.control to allow active plots to be copied
    await this.#webRConsole.webR.evalRVoid(`
      options(device = function(...){
        pdf(...)
        dev.control("enable")
      }, webr.plot.new = FALSE)
    `);
    // Create a signal when there is a new plot to be shown in JupyterLite
    await this.#webRConsole.webR.evalRVoid(`
      setHook("grid.newpage", function() {
        options(webr.plot.new = TRUE)
      }, "replace")
      setHook("plot.new", function() {
        options(webr.plot.new = TRUE)
      }, "replace")
    `);
    // Default plot size
    await this.#webRConsole.webR.evalRVoid(`
      options(webr.plot.width = 7, webr.plot.height = 5.25)
    `);
  }

  async handleMessage(msg: KernelMessage.IMessage): Promise<void> {
    switch (msg.header.msg_type) {
      case 'execute_request': {
        this.#parentHeader = msg.header;
        await this.handleExecRequest(msg);
        break;
      }
      case 'input_reply': {
        const stdin = msg.content as KernelMessage.IInputReplyMsg['content'];
        if (stdin.status === 'ok') {
          this.#webRConsole.stdin(stdin.value);
        }
        break;
      }
      case 'kernel_info_request': {
        this.#parentHeader = msg.header;
        this.sendKernelInfoReply(msg);
        await this.ready;
        this.sendKernelStatus('idle');
        break;
      }
      default:
        console.warn(`Unhandled message type: ${msg.header.msg_type}`);
    }
  }

  async handleExecRequest(msg: KernelMessage.IMessage): Promise<void> {
    const req = msg as KernelMessage.IExecuteRequestMsg;
    this.sendKernelStatus('busy');
    if (req.content.store_history) {
      this.#executionCounter = this.#executionCounter + 1;
    }
    await this.#envSetup;

    try {
      const exec = await this.#shelter.captureR(req.content.code, {
        withAutoprint: true,
        captureGraphics: false, // We handle graphics capture, to support incremental plotting
      });
      const output = exec.output as { type: string; data: unknown }[];
      // Deal with showing stream and condition outputs
      output.forEach(async (out) => {
        switch (out.type) {
          case 'stdout':
            this.sendIOReply(msg, 'stream', { name: 'stdout', text: (out.data as string) + '\n' });
            break;
          case 'stderr':
            this.sendIOReply(msg, 'stream', { name: 'stderr', text: (out.data as string) + '\n' });
            break;
          case 'message': {
            const cnd = out.data as RList;
            const message = (await cnd.get('message')) as RCharacter;
            this.sendIOReply(msg, 'stream', {
              name: 'stderr',
              text: (await message.toString()) + '\n',
            });
            break;
          }
          case 'warning': {
            const cnd = out.data as RList;
            const message = (await cnd.get('message')) as RCharacter;
            this.sendIOReply(msg, 'stream', {
              name: 'stderr',
              text: 'Warning message:\n' + (await message.toString()) + '\n',
            });
            break;
          }
        }
      });

      // Send an R plot if there are changes to the graphics device
      await this.sendPlotOutput(msg);
      // Send success signal
      this.sendShellReply(msg, 'execute_reply', {
        status: 'ok',
        execution_count: this.#executionCounter,
        user_expressions: {},
      });
    } catch (e) {
      const evalue = (e as { message: string }).message;
      this.sendIOReply(msg, 'stream', { name: 'stderr', text: 'Error: ' + evalue + '\n' });
      this.sendShellReply(msg, 'execute_reply', {
        status: 'error',
        execution_count: this.#executionCounter,
        ename: 'error',
        evalue: evalue,
        traceback: [],
      });
    } finally {
      await this.#shelter.purge();
    }
    this.sendKernelStatus('idle');
  }

  async sendPlotOutput(msg: KernelMessage.IMessage): Promise<void> {
    const dev = await this.#webRConsole.webR.evalRNumber('dev.cur()');
    const newPlot = await this.#webRConsole.webR.evalRBoolean('getOption("webr.plot.new")');
    if (dev > 1) {
      const capturePlot = await this.#shelter.captureR(`
        try({
          w <- getOption("webr.plot.width")
          h <- getOption("webr.plot.height")
          webr::canvas(width = 72 * w, height = 72 * h, capture = TRUE)
          capture_dev = dev.cur();

          dev.set(${dev})
          dev.copy(which = capture_dev)
          dev.off(capture_dev)
          recordPlot()
        }, silent = TRUE)
      `);
      const image = capturePlot.images[0];
      this.#bitmapCanvas.width = image.width;
      this.#bitmapCanvas.height = image.height;
      this.#bitmapCanvas.getContext('bitmaprenderer')?.transferFromImageBitmap(image);
      const plotData = this.#bitmapCanvas.toDataURL('image/png');

      // Send plot data to client if a new.plot() has been triggered or if
      // the plot has changed since last time
      const plotChanged = await this.#webRConsole.webR.evalRBoolean('!identical(a, b)', {
        env: {
          a: this.#lastRecord,
          b: capturePlot.result,
        }
      })
      if (newPlot || plotChanged) {
        this.#lastRecord = capturePlot.result;
        this.sendIOReply(msg, 'display_data', {
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
        await this.#webRConsole.webR.evalRVoid('options(webr.plot.new = FALSE)');
      }
    }
  }

  sendStdinRequest(content: KernelMessage.IInputRequestMsg['content']): void {
    const reply: KernelMessage.IInputRequestMsg = {
      header: {
        msg_id: uuid(),
        username: this.#parentHeader ? this.#parentHeader.username : '',
        session: this.#parentHeader ? this.#parentHeader.session : '',
        date: new Date().toISOString(),
        msg_type: 'input_request',
        version: protocolVersion,
      },
      parent_header: this.#parentHeader as KernelMessage.IHeader,
      metadata: {},
      content,
      buffers: [],
      channel: 'stdin',
    };
    this.#sendMessage(reply);
  }

  sendIOReply(
    msg: KernelMessage.IMessage,
    type: KernelMessage.IOPubMessageType,
    content: KernelMessage.IIOPubMessage['content']
  ): void {
    const reply: KernelMessage.IIOPubMessage = {
      header: {
        msg_id: uuid(),
        username: msg.header.username,
        session: msg.header.session,
        date: new Date().toISOString(),
        msg_type: type,
        version: protocolVersion,
      },
      parent_header: msg.header,
      metadata: {},
      content,
      buffers: [],
      channel: 'iopub',
    };
    this.#sendMessage(reply);
  }

  sendShellReply(
    msg: KernelMessage.IMessage,
    type: KernelMessage.ShellMessageType,
    content: KernelMessage.IShellMessage['content']
  ): void {
    const reply: KernelMessage.IShellMessage = {
      header: {
        msg_id: uuid(),
        username: msg.header.username,
        session: msg.header.session,
        date: new Date().toISOString(),
        msg_type: type,
        version: protocolVersion,
      },
      parent_header: msg.header as KernelMessage.IHeader,
      metadata: {},
      content,
      buffers: [],
      channel: 'shell',
    };
    this.#sendMessage(reply);
  }

  sendKernelInfoReply(msg: KernelMessage.IMessage): void {
    const reply: KernelMessage.IInfoReplyMsg = {
      header: {
        msg_id: uuid(),
        username: msg.header.username,
        session: msg.header.session,
        date: new Date().toISOString(),
        msg_type: 'kernel_info_reply',
        version: protocolVersion,
      },
      parent_header: msg.header as KernelMessage.IHeader<'kernel_info_request'>,
      metadata: {},
      content: {
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
        help_links: [],
      },
      buffers: [],
      channel: 'shell',
    };
    this.#sendMessage(reply);
  }

  sendKernelStatus(status: KernelMessage.Status): void {
    const msg: KernelMessage.IIOPubMessage = {
      channel: 'iopub',
      header: {
        msg_id: uuid(),
        username: this.#parentHeader ? this.#parentHeader.username : '',
        session: this.#parentHeader ? this.#parentHeader.session : '',
        date: new Date().toISOString(),
        msg_type: 'status',
        version: protocolVersion,
      },
      content: {
        execution_state: status,
      },
      metadata: {},
      parent_header: {},
    };
    this.#sendMessage(msg);
  }
}
