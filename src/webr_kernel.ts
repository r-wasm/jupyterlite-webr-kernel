import { KernelMessage } from '@jupyterlab/services';
import { IKernel } from '@jupyterlite/kernel';
import { ISignal, Signal } from '@lumino/signaling';

export namespace WebRKernel {
  export interface IOptions extends IKernel.IOptions {}
}

export class WebRKernel implements IKernel {
  #id: string;
  #name: string;
  #location: string;
  #isDisposed = false;
  #disposed = new Signal<this, void>(this);
  //@ts-expect-error used
  #sendMessage: IKernel.SendMessage;
  #parentHeader: KernelMessage.IHeader<KernelMessage.MessageType> | undefined = undefined;
  #parent: KernelMessage.IMessage | undefined = undefined;

  constructor(options: WebRKernel.IOptions) {
    const { id, name, sendMessage, location } = options;
    this.#id = id;
    this.#name = name;
    this.#location = location;
    this.#sendMessage = sendMessage;
  }

  async handleMessage(msg: KernelMessage.IMessage): Promise<void> {
    this.#parent = msg;
    this.#parentHeader = msg.header;
    console.log(msg);
    // await this._sendMessageToWorker(msg);
  }

  get parentHeader(): KernelMessage.IHeader<KernelMessage.MessageType> | undefined {
    return this.#parentHeader;
  }

  get parent(): KernelMessage.IMessage | undefined {
    return this.#parent;
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
    return Promise.resolve();
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
}
