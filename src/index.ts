import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { IKernel, IKernelSpecs } from '@jupyterlite/kernel';
import { PageConfig, URLExt } from '@jupyterlab/coreutils';
import { WebRKernel } from './webr_kernel';
import logo32 from '!!file-loader?context=.!../style/logos/r-logo-32x32.png';
import logo64 from '!!file-loader?context=.!../style/logos/r-logo-64x64.png';
import type { WebROptions } from 'webr';

const PLUGIN_ID = '@r-wasm/webr-kernel-extension:kernel';

const server_kernel: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  autoStart: true,
  requires: [IKernelSpecs],
  activate: (app: JupyterFrontEnd, kernelspecs: IKernelSpecs) => {
    const config = JSON.parse(
      PageConfig.getOption('litePluginSettings') || '{}'
    )[PLUGIN_ID] || {};

    const webROptions: WebROptions = {
      REnv: {
          R_HOME: '/usr/lib/R',
          FONTCONFIG_PATH: '/etc/fonts',
          R_ENABLE_JIT: '0',
      },
    };

    if (config.baseUrl) {
      webROptions.baseUrl = URLExt.parse(config.baseUrl).href;
    }

    if (config.repoUrl) {
      webROptions.repoUrl = URLExt.parse(config.repoUrl).href;
    }

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
        return new WebRKernel({ ...options }, webROptions);
      },
    });
  },
};

const plugins: JupyterFrontEndPlugin<any>[] = [server_kernel];
export default plugins;