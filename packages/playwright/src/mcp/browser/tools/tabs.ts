/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { z } from 'playwright-core/lib/mcpBundle';
import { defineTool } from './tool';
import { renderTabsMarkdown } from '../response';

function isInternalUrl(url: string): boolean {
  if (url.startsWith('file://') || url.startsWith('data:') || url.startsWith('chrome-extension://'))
    return true;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
      return true;
  } catch { /* not internal */ }
  return false;
}

const browserTabs = defineTool({
  capability: 'core-tabs',

  schema: {
    name: 'browser_tabs',
    title: 'Manage tabs',
    description: 'List, create, close, or select a browser tab.',
    inputSchema: z.object({
      action: z.enum(['list', 'new', 'close', 'select']).describe('Operation to perform'),
      index: z.number().optional().describe('Tab index, used for close/select. If omitted for close, current tab is closed.'),
    }),
    type: 'action',
  },

  handle: async (context, params, response) => {
    switch (params.action) {
      case 'list': {
        await context.ensureTab();
        break;
      }
      case 'new': {
        await context.newTab();
        break;
      }
      case 'close': {
        await context.closeTab(params.index);
        break;
      }
      case 'select': {
        if (params.index === undefined)
          throw new Error('Tab index is required');
        await context.selectTab(params.index);
        break;
      }
    }
    const allHeaders = await Promise.all(context.tabs().map(tab => tab.headerSnapshot()));

    if (context.config.filterInternalUrls) {
      const lines: string[] = [];
      for (let i = 0; i < allHeaders.length; i++) {
        if (isInternalUrl(allHeaders[i].url))
          continue;
        const tab = allHeaders[i];
        const current = tab.current ? ' (current)' : '';
        lines.push(`- ${i}:${current} [${tab.title}](${tab.url})`);
      }
      response.addTextResult(lines.length ? lines.join('\n') : 'No visible tabs. Navigate to a URL to create one.');
    } else {
      response.addTextResult(renderTabsMarkdown(allHeaders).join('\n'));
    }
  },
});

export default [
  browserTabs,
];
