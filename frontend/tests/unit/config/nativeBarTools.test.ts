import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NativeBarTools } from '@/config/nativeBarTools';

/**
 * The web and Swift halves of `setBarTools` agree on every field name. The
 * shapes are written once, in config/nativeBarTools.ts; Swift reads them in
 * NativeChromePlugin.swift (`setBarTools`) and NativeBarTools.swift
 * (`BarTools.parse`). A renamed field on either side would draw an empty bar
 * without any error, so the names are compared here.
 */
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const plugin = read('ios/App/App/NativeChromePlugin.swift');
const model = read('ios/App/App/NativeBarTools.swift');
const pbx = read('ios/App/App.xcodeproj/project.pbxproj');

const sample: NativeBarTools = {
  path: '/plants',
  menus: [
    {
      id: 'filter',
      label: 'Filter plants',
      symbol: 'line.3.horizontal.decrease.circle',
      groups: [{ title: 'Group by', items: [{ id: 'group:care', label: 'Care', checked: true }] }],
    },
  ],
  search: { placeholder: 'Search plants', text: '' },
};

describe('setBarTools, web and Swift', () => {
  it('the plugin reads path, menus and search by the names the web sends', () => {
    const body = plugin.slice(
      plugin.indexOf('@objc func setBarTools('),
      plugin.indexOf('func sendBarMenuSelect(')
    );
    const read = new Set([...body.matchAll(/call\.get\w+\("([^"]+)"\)/g)].map((m) => m[1]));
    expect([...read].sort()).toEqual(Object.keys(sample).sort());
  });

  it('the parser reads every menu, group, item and search field by the same name', () => {
    const parse = model.slice(model.indexOf('static func parse('), model.indexOf('func offers('));
    const keys = new Set([...parse.matchAll(/\w+\["([^"]+)"\]/g)].map((m) => m[1]));
    const menu = sample.menus[0];
    const expected = new Set([
      ...Object.keys(menu),
      ...Object.keys(menu.groups[0]),
      ...Object.keys(menu.groups[0].items[0]),
      ...Object.keys(sample.search!),
    ]);
    expect([...keys].sort()).toEqual([...expected].sort());
  });

  it('only reports a menu pick the web offered for that route', () => {
    const frame = read('ios/App/App/NativeFrameController.swift');
    const picked = frame.slice(frame.indexOf('func barMenuPicked('));
    expect(picked).toMatch(
      /guard let tools = barToolsStore\.tools\(for: path\), tools\.offers\(id\)/
    );
  });

  it('the new Swift file is compiled into the app', () => {
    expect(pbx).toContain('NativeBarTools.swift in Sources */,');
    expect(pbx).toContain('path = NativeBarTools.swift;');
  });
});
