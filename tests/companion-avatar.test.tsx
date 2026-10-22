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

it('renders the companion avatar instead of a hashed specialist image when customized', () => {
  const desktop = renderToStaticMarkup(
    createElement(Mascot, {
      identity: 'specialist',
      companionColor: '#f5a0be',
    }),
  );
  expect(desktop).toContain('companion-avatar');
  expect(desktop).toContain('/dots/blue.png');
  const browser = renderToStaticMarkup(
    createElement(Mascot, { identity: 'specialist' }),
  );
  expect(browser).toContain('/dots/');
  expect(browser).not.toContain('companion-avatar');
});
