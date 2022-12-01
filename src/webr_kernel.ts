import { KernelMessage } from '@jupyterlab/services';
import { IKernel } from '@jupyterlite/kernel';
import { ISignal, Signal } from '@lumino/signaling';
import { v4 as uuid } from 'uuid';
import { WebR } from '@georgestagg/webr';
import { RObjData, RInteger } from '@georgestagg/webr/dist/webR/robj';
import { sha256 } from 'hash.js';

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
  #webR: WebR;
  #init: Promise<any>;
  #envSetup: Promise<any>;
  #lastPlotHash: string | undefined = undefined;

  constructor(options: WebRKernel.IOptions) {
    const { id, name, sendMessage, location } = options;
    this.#id = id;
    this.#name = name;
    this.#location = location;
    this.#sendMessage = sendMessage;
    this.#webR = new WebR();
    this.sendKernelStatus('starting');
    this.#init = this.#webR.init();
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
    await this.#webR.installPackages(['svglite']);
    await this.#webR.evalRCode(`
      library(svglite)
      options(device = function(...){
        pdf(...)
        dev.control("enable")
      })
    `);
    this.sendKernelStatus('idle');
  }

  async handleMessage(msg: KernelMessage.IMessage): Promise<void> {
    this.#parentHeader = msg.header;
    switch (msg.header.msg_type) {
      case 'execute_request': {
        const req = msg as KernelMessage.IExecuteRequestMsg;
        this.sendKernelStatus('busy');
        if (req.content.store_history) {
          this.#executionCounter = this.#executionCounter + 1;
        }
        let status: 'ok' | 'error' = 'ok';
        await this.#envSetup;
        const exec = await this.#webR.evalRCode(req.content.code, undefined, {
          withAutoprint: true,
          captureStreams: true,
        });
        const output = exec.output as { type: string; data: unknown }[];
        output.forEach((out) => {
          switch (out.type) {
            case 'stdout':
              this.sendStreamReply(msg, 'stdout', (out.data as string) + '\n');
              break;
            case 'stderr':
              this.sendStreamReply(msg, 'stderr', (out.data as string) + '\n');
              break;
            case 'message': {
              const data = out.data as { names: string[]; values: [string, RObjData] };
              this.sendStreamReply(msg, 'stderr', data.values[0] + '\n');
              break;
            }
            case 'warning': {
              const data = out.data as { names: string[]; values: [string, RObjData] };
              this.sendStreamReply(msg, 'stderr', 'Warning message:\n' + data.values[0] + '\n');
              break;
            }
            case 'error': {
              status = 'error';
              const data = out.data as { names: string[]; values: [string, RObjData] };
              this.sendStreamReply(msg, 'stderr', 'Error: ' + data.values[0] + '\n');
              // TODO: intepret the call stack to report a traceback
              this.sendExecuteReply(msg, {
                status: status,
                execution_count: this.#executionCounter,
                ename: 'error',
                evalue: data.values[0],
                traceback: [],
              });
              break;
            }
          }
        });

        const dev = (await this.#webR.evalRCode('dev.cur()')).result as RInteger;
        const devNumber = await dev.toNumber();
        if (devNumber && devNumber > 1) {
          await this.#webR.evalRCode(`
            try({
              dev.copy(function(...) {
                svglite(width = 6.25, height = 5, ...)
              }, "/tmp/_webRplots.svg")
              dev.off()
            }, silent=TRUE)
          `);
          const plotData = await this.#webR.getFileData('/tmp/_webRplots.svg');
          const plotHash = sha256().update(plotData).digest('hex');
          if (!this.#lastPlotHash || plotHash !== this.#lastPlotHash) {
            this.#lastPlotHash = plotHash;
            this.sendExecuteResult(msg, {
              execution_count: this.#executionCounter,
              data: {
                'image/svg+xml': new TextDecoder().decode(plotData),
              },
              metadata: {
                'image/svg+xml': {
                  isolated: true,
                },
              },
            });
          }
        }

        if (status === 'ok') {
          this.sendExecuteReply(msg, {
            status: status,
            execution_count: this.#executionCounter,
            user_expressions: {},
          });
        }

        this.sendKernelStatus('idle');
        break;
      }
      case 'kernel_info_request': {
        this.sendKernelInfoReply(msg);
        this.ready.then(() => this.sendKernelStatus('busy'));
        break;
      }
      default:
        console.warn(`Unhandled message type: ${msg.header.msg_type}`);
    }
  }

  sendExecuteResult(
    msg: KernelMessage.IMessage,
    content: KernelMessage.IExecuteResultMsg['content']
  ): void {
    const reply: KernelMessage.IExecuteResultMsg = {
      header: {
        msg_id: uuid(),
        username: msg.header.username,
        session: msg.header.session,
        date: new Date().toISOString(),
        msg_type: 'execute_result',
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

  sendExecuteReply(
    msg: KernelMessage.IMessage,
    content: KernelMessage.IExecuteReplyMsg['content']
  ): void {
    const reply: KernelMessage.IExecuteReplyMsg = {
      header: {
        msg_id: uuid(),
        username: msg.header.username,
        session: msg.header.session,
        date: new Date().toISOString(),
        msg_type: 'execute_reply',
        version: protolcolVersion,
      },
      parent_header: msg.header as KernelMessage.IHeader<'execute_request'>,
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
          mimetype: 'text/plain',
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

  sendStreamReply(msg: KernelMessage.IMessage, name: 'stdout' | 'stderr', text: string): void {
    const reply: KernelMessage.IIOPubMessage = {
      channel: 'iopub',
      header: {
        msg_id: uuid(),
        username: msg.header.username,
        session: msg.header.session,
        date: new Date().toISOString(),
        msg_type: 'stream',
        version: protolcolVersion,
      },
      content: { name: name, text },
      metadata: {},
      parent_header: msg.header,
    };
    this.#sendMessage(reply);
  }
}
