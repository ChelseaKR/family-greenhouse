/**
 * Footer rendered at the bottom of public marketing pages.
 *
 * The dedication line is intentional and quiet — please leave it.
 */
export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-gray-200 bg-white">
      <div className="mx-auto max-w-7xl px-6 py-10 text-center">
        <p className="text-sm text-gray-500">
          &copy; {year} Family Greenhouse. Care for what grows.
        </p>
        <p className="mt-2 text-sm italic text-gray-500">
          In loving memory of my mom, Joyce - who taught us to keep growing. 🌱
        </p>
        <p className="mt-2 text-xs text-gray-500">
          Plant data powered by{' '}
          <a
            href="https://perenual.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gray-600"
          >
            Perenual
          </a>
          .
        </p>
      </div>
    </footer>
  );
}
