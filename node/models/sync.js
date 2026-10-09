import connection from '../../Mysql/index.js';
import { syncModels } from './service.js';

try {
  console.log(await syncModels());
} finally {
  await connection.end();
}
