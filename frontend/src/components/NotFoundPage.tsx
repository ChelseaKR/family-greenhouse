import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4">
      <h1 className="text-6xl font-bold text-primary-700">404</h1>
      <p className="mt-4 text-xl text-gray-600">Page not found</p>
      <p className="mt-2 text-gray-500">Sorry, we couldn't find the page you're looking for.</p>
      <Link to="/" className="mt-6 btn-primary">
        Go back home
      </Link>
    </main>
  );
}
