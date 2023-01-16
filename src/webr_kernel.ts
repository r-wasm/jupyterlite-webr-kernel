import { KernelMessage } from '@jupyterlab/services';
import { IKernel } from '@jupyterlite/kernel';
import { ISignal, Signal } from '@lumino/signaling';
import { v4 as uuid } from 'uuid';
import { sha256 } from 'hash.js';

import { Console } from '@r-wasm/webr';
import { RCharacter, RLogical, RList, RInteger } from '@r-wasm/webr/robj-main';

export namespace WebRKernel {
  export interface IOptions extends IKernel.IOptions {}
}

const webRVersion = '0.1.0';
const baseRVersion = '3.1.4';
const protolcolVersion = '5.2';

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
  #lastPlotHash: string | undefined = undefined;

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
    await this.#webRConsole.webR.installPackages(['svglite']);
    await this.#webRConsole.webR.evalR('library(svglite)');
    // Enable dev.control to allow active plots to be copied
    await this.#webRConsole.webR.evalR(`
      options(device = function(...){
        pdf(...)
        dev.control("enable")
      }, webr.fig.new = FALSE)
    `);
    // Create a signal when there is a new plot to be shown in JupyterLite
    await this.#webRConsole.webR.evalR(`
      setHook("before.plot.new", function() {
        options(webr.fig.new = TRUE)
      }, "replace")
    `);
    // Default plot size
    await this.#webRConsole.webR.evalR(`
      options(webr.fig.width = 6, webr.fig.height = 4.5)
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
      const exec = await this.#webRConsole.webR.captureR(req.content.code, undefined, {
        withAutoprint: true,
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
    }
    this.sendKernelStatus('idle');
  }

  async sendPlotOutput(msg: KernelMessage.IMessage): Promise<void> {
    const dev = (await this.#webRConsole.webR.evalR('dev.cur()')) as RInteger;
    const newPlot = (await this.#webRConsole.webR.evalR(
      'options("webr.fig.new")[[1]]'
    )) as RLogical;
    const devNumber = await dev.toNumber();
    const newPlotLogical = await newPlot.toBoolean();
    if (devNumber && devNumber > 1) {
      await this.#webRConsole.webR.evalR(`
        try({
          dev.copy(function(...) {
            w <- options("webr.fig.width")[[1]]
            h <- options("webr.fig.height")[[1]]
            svglite(width = w, height = h, ...)
          }, "/tmp/_webRplots.svg")
          dev.off()
        }, silent=TRUE)
      `);
      const plotData = await this.#webRConsole.webR.FS.readFile('/tmp/_webRplots.svg');

      // Send plot data to client if a new.plot() has been triggered or if
      // the plot has changed since last time
      const plotHash = sha256().update(plotData).digest('hex');
      if (newPlotLogical || !this.#lastPlotHash || plotHash !== this.#lastPlotHash) {
        this.#lastPlotHash = plotHash;
        this.sendIOReply(msg, 'display_data', {
          data: {
            'image/svg+xml': new TextDecoder().decode(plotData),
          },
          metadata: {
            'image/svg+xml': {
              isolated: true,
            },
          },
        });
        await this.#webRConsole.webR.evalR('options(webr.fig.new = FALSE)');
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
        version: protolcolVersion,
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
        version: protolcolVersion,
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
        version: protolcolVersion,
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
        version: protolcolVersion,
      },
      parent_header: msg.header as KernelMessage.IHeader<'kernel_info_request'>,
      metadata: {},
      content: {
        status: 'ok',
        protocol_version: protolcolVersion,
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
        version: protolcolVersion,
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
