import { JupyterLiteServer, JupyterLiteServerPlugin } from '@jupyterlite/server';
import { IKernel, IKernelSpecs } from '@jupyterlite/kernel';
import { WebRKernel } from './webr_kernel';
import logo32 from '!!file-loader?context=.!../style/logos/r-logo-32x32.png';
import logo64 from '!!file-loader?context=.!../style/logos/r-logo-64x64.png';

const server_kernel: JupyterLiteServerPlugin<void> = {
  id: '@jupyterlite/webr-kernel-extension:kernel',
  autoStart: true,
  requires: [IKernelSpecs],
  activate: (app: JupyterLiteServer, kernelspecs: IKernelSpecs) => {
    kernelspecs.register({
      spec: {
        name: 'webR',
        display_name: 'R (webR)',
        language: 'R',
        argv: [],
        spec: {
          argv: [],
          env: {},
          display_name: 'R (webR)',
          language: 'R',
          interrupt_mode: 'message',
          metadata: {},
        },
        resources: {
          'logo-32x32': logo32,
          'logo-64x64': logo64,
        },
      },
      create: async (options: IKernel.IOptions): Promise<IKernel> => {
        return new WebRKernel({ ...options });
      },
    });
  },
};

const plugins: JupyterLiteServerPlugin<any>[] = [server_kernel];
export default plugins;
