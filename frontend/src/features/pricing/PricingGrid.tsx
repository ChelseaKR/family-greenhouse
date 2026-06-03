import { Link } from 'react-router-dom';
import { CheckIcon } from '@heroicons/react/24/outline';
import clsx from 'clsx';
import { Button } from '@/components/Button';
import { PRICING_PLANS } from './plans';
import { IS_BETA, BETA_NOTICE } from '@/lib/betaMode';

/**
 * Three-card pricing grid, shared by the LandingPage anchor section and
 * the standalone `/pricing` page. Highlighted plan gets the dark plate +
 * inverted CTA; the `!` prefix on the override classes wins against the
 * Button variant's equal-specificity defaults (otherwise the inverted
 * CTA renders white-on-white).
 */
export function PricingGrid() {
  return (
    <>
      {IS_BETA && (
        <div
          role="status"
          className="mx-auto mt-8 max-w-2xl rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-center text-sm text-amber-900"
        >
          <span className="font-semibold">Beta:</span> {BETA_NOTICE}
        </div>
      )}
      <div className="mx-auto mt-12 grid max-w-lg grid-cols-1 gap-8 lg:max-w-none lg:grid-cols-3">
        {PRICING_PLANS.map((plan) => (
          <div
            key={plan.name}
            className={clsx(
              'flex flex-col rounded-2xl p-8',
              plan.highlighted
                ? 'bg-primary-700 text-white ring-2 ring-primary-700 lg:scale-105 shadow-xl'
                : 'bg-white ring-1 ring-gray-200'
            )}
          >
            <h3
              className={clsx(
                'text-lg font-semibold',
                plan.highlighted ? 'text-white' : 'text-gray-900'
              )}
            >
              {plan.name}
            </h3>
            <p
              className={clsx(
                'mt-2 text-sm',
                plan.highlighted ? 'text-primary-100' : 'text-gray-500'
              )}
            >
              {plan.description}
            </p>
            <div className="mt-6 flex items-baseline gap-1">
              <span
                className={clsx(
                  'text-4xl font-bold',
                  plan.highlighted ? 'text-white' : 'text-gray-900'
                )}
              >
                {plan.price}
              </span>
              {plan.period && (
                <span
                  className={clsx(
                    'text-sm',
                    plan.highlighted ? 'text-primary-100' : 'text-gray-500'
                  )}
                >
                  {plan.period}
                </span>
              )}
            </div>
            <ul className="mt-8 space-y-3 flex-1">
              {plan.features.map((feature) => (
                <li key={feature} className="flex items-center gap-3">
                  <CheckIcon
                    className={clsx(
                      'h-5 w-5 flex-shrink-0',
                      plan.highlighted ? 'text-primary-200' : 'text-primary-700'
                    )}
                    aria-hidden="true"
                  />
                  <span
                    className={clsx(
                      'text-sm',
                      plan.highlighted ? 'text-primary-50' : 'text-gray-600'
                    )}
                  >
                    {feature}
                  </span>
                </li>
              ))}
            </ul>
            <Link to="/register" className="mt-8 block">
              <Button
                variant={plan.highlighted ? 'secondary' : 'primary'}
                className={clsx(
                  'w-full',
                  plan.highlighted &&
                    '!bg-white !text-primary-700 !border-transparent hover:!bg-primary-50'
                )}
              >
                {IS_BETA ? 'Sign up free' : plan.cta}
              </Button>
            </Link>
          </div>
        ))}
      </div>
    </>
  );
}
