import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Mascot } from '../src/client/Mascot';
import { companionColorFromSearch } from '../src/client/companion-appearance';

it('reads the shared color in workspace, companion and legacy desktop URLs', () => {
  expect(companionColorFromSearch('?desktop=1&dotColor=%23f5a0be')).toBe(
    '#f5a0be',
  );
  expect(
    companionColorFromSearch('?surface=workspace&dotColor=%23f5a0be'),
  ).toBe('#f5a0be');
  expect(
    companionColorFromSearch('?surface=companion&dotColor=%2355aa88'),
  ).toBe('#55aa88');
  expect(companionColorFromSearch('?surface=workspace')).toBe('#45a7ff');
  expect(companionColorFromSearch('?dotColor=%23f5a0be')).toBeUndefined();
  expect(companionColorFromSearch('?desktop=1&dotColor=red')).toBe('#45a7ff');
});

it('does not apply an app-wide color override to an identified Dot', () => {
  const desktop = renderToStaticMarkup(
    createElement(Mascot, {
      identity: 'specialist',
      companionColor: '#f5a0be',
    }),
  );
  expect(desktop).toContain('companion-avatar');
  expect(desktop).toContain('/dots/blue.png');
  expect(desktop).toContain('data-color="#45a7ff"');
  const browser = renderToStaticMarkup(
    createElement(Mascot, { identity: 'specialist' }),
  );
  expect(browser).toContain('/dots/');
  expect(browser).toContain('companion-avatar');
});
