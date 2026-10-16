import {
  PayPalButtons,
  PayPalScriptProvider,
  type PayPalButtonsComponentProps,
} from '@paypal/react-paypal-js'

export type PayPalSubscriptionButtonProps = {
  clientId: string
  createSubscription: NonNullable<PayPalButtonsComponentProps['createSubscription']>
  onApprove: NonNullable<PayPalButtonsComponentProps['onApprove']>
  onCancel: NonNullable<PayPalButtonsComponentProps['onCancel']>
  onError: NonNullable<PayPalButtonsComponentProps['onError']>
}

export function PayPalSubscriptionButtons({
  clientId,
  createSubscription,
  onApprove,
  onCancel,
  onError,
}: PayPalSubscriptionButtonProps) {
  return (
    <PayPalScriptProvider
      options={{
        clientId,
        vault: true,
        intent: 'subscription',
      }}
    >
      <PayPalButtons
        createSubscription={createSubscription}
        onApprove={onApprove}
        onCancel={onCancel}
        onError={onError}
        style={{ layout: 'vertical', label: 'subscribe' }}
      />
    </PayPalScriptProvider>
  )
}
