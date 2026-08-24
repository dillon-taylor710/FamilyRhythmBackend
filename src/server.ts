import { app } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';

app.listen(env.PORT, '0.0.0.0', () => {
  logger.info(`Family Rhythm backend listening on http://0.0.0.0:${env.PORT}`);
});
