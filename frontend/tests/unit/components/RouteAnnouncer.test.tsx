import { describe, it, expect, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { RouteAnnouncer, ROUTE_LOADING_ATTRIBUTE } from '@/components/RouteAnnouncer';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

function Page({ title }: { title: string }) {
  useDocumentTitle(title);
  return <h1>{title}</h1>;
}

function renderApp(initial = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <RouteAnnouncer />
      <nav>
        <Link to="/plants">Plants</Link>
        <Link to="/tasks">Tasks</Link>
        <Link to="/plants?view=list">List view</Link>
      </nav>
      <Routes>
        <Route path="/dashboard" element={<Page title="Dashboard" />} />
        <Route path="/plants" element={<Page title="Plants" />} />
        <Route path="/tasks" element={<Page title="Tasks" />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('RouteAnnouncer', () => {
  afterEach(() => {
    document.title = '';
  });

  it('stays quiet on the first page, which the browser announces itself', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('says the new page title after a route change', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('link', { name: 'Plants' }));

    const status = screen.getByRole('status');
    await waitFor(() => expect(status).toHaveTextContent('Plants • Family Greenhouse'));
    // The whole title is read, not only the part that changed.
    expect(status).toHaveAttribute('aria-atomic', 'true');

    await user.click(screen.getByRole('link', { name: 'Tasks' }));
    await waitFor(() => expect(status).toHaveTextContent('Tasks • Family Greenhouse'));
  });

  it('keeps the link that was used focused', async () => {
    const user = userEvent.setup();
    renderApp();
    const link = screen.getByRole('link', { name: 'Plants' });
    await user.click(link);
    await waitFor(() => expect(screen.getByRole('status')).not.toBeEmptyDOMElement());
    expect(link).toHaveFocus();
  });

  it('says nothing when only the query string changes', async () => {
    const user = userEvent.setup();
    renderApp('/plants');
    await user.click(screen.getByRole('link', { name: 'List view' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('waits for a lazy route that is still loading before it reads the title', async () => {
    const user = userEvent.setup();
    renderApp();
    // What the Suspense fallback puts on screen while a chunk is on its way.
    const spinner = document.createElement('div');
    spinner.setAttribute(ROUTE_LOADING_ATTRIBUTE, '');
    document.body.appendChild(spinner);

    await user.click(screen.getByRole('link', { name: 'Plants' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    spinner.remove();
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Plants • Family Greenhouse')
    );
  });
});
