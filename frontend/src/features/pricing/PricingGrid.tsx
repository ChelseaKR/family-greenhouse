import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckIcon } from '@heroicons/react/24/outline';
import clsx from 'clsx';
import { Button } from '@/components/Button';
import { PRICING_PLANS } from './plans';
import { IS_BETA, BETA_NOTICE } from '@/lib/betaMode';

type Interval = 'monthly' | 'annual';

/**
 * Three-card pricing grid, shared by the LandingPage anchor section and
 * the standalone `/pricing` page. Highlighted plan gets the dark plate +
 * inverted CTA; the `!` prefix on the override classes wins against the
 * Button variant's equal-specificity defaults (otherwise the inverted
 * CTA renders white-on-white).
 */
export function PricingGrid() {
  // Annual is the default cadence — better value for the buyer, better
  // retention for us.
  const [interval, setInterval] = useState<Interval>('annual');
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
      <div className="mt-10 flex items-center justify-center gap-3">
        <div
          role="radiogroup"
          aria-label="Billing interval"
          className="inline-flex rounded-full bg-gray-100 p-1"
        >
          {(['monthly', 'annual'] as Interval[]).map((opt) => (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={interval === opt}
              onClick={() => setInterval(opt)}
              className={clsx(
                'rounded-full px-5 py-1.5 text-sm font-medium capitalize transition-colors',
                interval === opt ? 'bg-white text-primary-700 shadow-sm' : 'text-gray-500'
              )}
            >
              {opt}
            </button>
          ))}
        </div>
        <span className="rounded-full bg-primary-50 px-2.5 py-1 text-xs font-medium text-primary-700">
          Save ~33% yearly
        </span>
      </div>
      <div className="mx-auto mt-12 grid max-w-lg grid-cols-1 gap-8 md:max-w-none md:grid-cols-3 md:gap-6 lg:gap-8">
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
            {(() => {
              // Free tier shows a single label; paid tiers show the price for
              // the selected cadence (falling back to monthly if a tier somehow
              // lacks an annual point).
              const point =
                interval === 'annual' ? (plan.annual ?? plan.monthly) : plan.monthly;
              return (
                <div className="mt-6">
                  <div className="flex items-baseline gap-1">
                    <span
                      className={clsx(
                        'text-4xl font-bold',
                        plan.highlighted ? 'text-white' : 'text-gray-900'
                      )}
                    >
                      {plan.freeLabel ?? point?.price}
                    </span>
                    {point?.period && (
                      <span
                        className={clsx(
                          'text-sm',
                          plan.highlighted ? 'text-primary-100' : 'text-gray-500'
                        )}
                      >
                        {point.period}
                      </span>
                    )}
                  </div>
                  {point?.note && (
                    <p
                      className={clsx(
                        'mt-1 text-xs',
                        plan.highlighted ? 'text-primary-100' : 'text-primary-700'
                      )}
                    >
                      {point.note}
                    </p>
                  )}
                </div>
              );
            })()}
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
