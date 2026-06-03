import { ReactNode } from 'react';
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import clsx from 'clsx';

type AlertVariant = 'success' | 'error' | 'warning' | 'info';

interface AlertProps {
  variant: AlertVariant;
  title?: string;
  children: ReactNode;
  className?: string;
}

const variantConfig = {
  success: {
    icon: CheckCircleIcon,
    bgClass: 'bg-green-50',
    textClass: 'text-green-800',
    iconClass: 'text-green-400',
  },
  error: {
    icon: XCircleIcon,
    bgClass: 'bg-red-50',
    textClass: 'text-red-800',
    iconClass: 'text-red-400',
  },
  warning: {
    icon: ExclamationTriangleIcon,
    bgClass: 'bg-yellow-50',
    textClass: 'text-yellow-800',
    iconClass: 'text-yellow-400',
  },
  info: {
    icon: InformationCircleIcon,
    bgClass: 'bg-blue-50',
    textClass: 'text-blue-800',
    iconClass: 'text-blue-400',
  },
};

export function Alert({ variant, title, children, className }: AlertProps) {
  const config = variantConfig[variant];
  const Icon = config.icon;

  return (
    <div className={clsx('rounded-md p-4', config.bgClass, className)} role="alert">
      <div className="flex">
        <div className="flex-shrink-0">
          <Icon className={clsx('h-5 w-5', config.iconClass)} aria-hidden="true" />
        </div>
        <div className="ml-3">
          {title && <h3 className={clsx('text-sm font-medium', config.textClass)}>{title}</h3>}
          <div className={clsx('text-sm', config.textClass, title && 'mt-2')}>{children}</div>
        </div>
      </div>
    </div>
  );
}
