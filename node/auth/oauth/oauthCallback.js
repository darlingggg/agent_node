export function getOAuthCallbackAction(session) {
  if (!session) return 'error';

  switch (session.status) {
    case 'waiting':
      return 'process';
    case 'processing':
      return 'processing';
    case 'success':
      return 'success';
    default:
      return 'error';
  }
}
