import { Redis } from '@upstash/redis';
import crypto from 'crypto';

const redis = Redis.fromEnv();

async function getAdminPassword() {
  try {
    const stored = await redis.get('admin:password');
    if (stored) return stored;
  } catch {}
  return process.env.ADMIN_PASSWORD;
}

async function checkAuth(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  const pwd = await getAdminPassword();
  if (!pwd || !token) return false;
  if (token.length !== pwd.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(pwd));
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  const { method } = req;
  const id = req.query?.id;

  try {
    if (method === 'GET' && id) {
      const invoice = await redis.get(`invoice:${id}`);
      if (!invoice) {
        return res.status(404).json({ ok: false, error: 'Invoice not found.' });
      }
      return res.status(200).json({
        ok: true,
        invoice: {
          id: invoice.id,
          amount: invoice.amount,
          description: invoice.description,
          status: invoice.status,
          issuedDate: invoice.issuedDate,
          dueDate: invoice.dueDate,
        },
      });
    }

    if (!(await checkAuth(req))) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    if (method === 'GET') {
      const ids = (await redis.smembers('invoice:ids')) || [];
      if (ids.length === 0) {
        return res.status(200).json({ ok: true, invoices: [] });
      }
      const invoices = await Promise.all(
        ids.map((invId) => redis.get(`invoice:${invId}`))
      );
      const filtered = invoices.filter(Boolean);
      filtered.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      return res.status(200).json({ ok: true, invoices: filtered });
    }

    if (method === 'POST') {
      const body = req.body || {};
      const {
        id: invoiceId,
        customer,
        email,
        amount,
        description,
        issuedDate,
        dueDate,
      } = body;

      if (!invoiceId || !amount || !description) {
        return res.status(400).json({
          ok: false,
          error: 'Invoice ID, amount, and description are required.',
        });
      }

      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum < 1) {
        return res.status(400).json({ ok: false, error: 'Amount must be at least $1.00.' });
      }

      const existing = await redis.get(`invoice:${invoiceId}`);
      if (existing) {
        return res.status(400).json({ ok: false, error: 'Invoice ID already exists.' });
      }

      const invoice = {
        id: invoiceId,
        customer: customer || '',
        email: email || '',
        amount: amountNum,
        description,
        issuedDate: issuedDate || new Date().toISOString().slice(0, 10),
        dueDate: dueDate || '',
        status: 'unpaid',
        createdAt: new Date().toISOString(),
      };

      await redis.set(`invoice:${invoiceId}`, invoice);
      await redis.sadd('invoice:ids', invoiceId);

      return res.status(200).json({ ok: true, invoice });
    }

    if (method === 'PATCH') {
      if (!id) return res.status(400).json({ ok: false, error: 'Missing invoice id.' });
      const invoice = await redis.get(`invoice:${id}`);
      if (!invoice) return res.status(404).json({ ok: false, error: 'Invoice not found.' });
      const body = req.body || {};
      if (body.status !== undefined) invoice.status = body.status;
      if (body.customer !== undefined) invoice.customer = body.customer;
      if (body.email !== undefined) invoice.email = body.email;
      if (body.description !== undefined) invoice.description = body.description;
      if (body.issuedDate !== undefined) invoice.issuedDate = body.issuedDate;
      if (body.dueDate !== undefined) invoice.dueDate = body.dueDate;
      if (body.amount !== undefined) {
        const amt = parseFloat(body.amount);
        if (isNaN(amt) || amt < 1) {
          return res.status(400).json({ ok: false, error: 'Amount must be at least $1.00.' });
        }
        invoice.amount = amt;
      }

      if (body.newId !== undefined) {
        const newId = String(body.newId).trim();
        if (!newId) {
          return res.status(400).json({ ok: false, error: 'Invoice number cannot be empty.' });
        }
        if (newId !== id) {
          const existing = await redis.get(`invoice:${newId}`);
          if (existing) {
            return res.status(409).json({ ok: false, error: `Invoice number "${newId}" is already in use.` });
          }
          invoice.id = newId;
          await redis.set(`invoice:${newId}`, invoice);
          await redis.sadd('invoice:ids', newId);
          await redis.del(`invoice:${id}`);
          await redis.srem('invoice:ids', id);
          return res.status(200).json({ ok: true, invoice });
        }
      }

      await redis.set(`invoice:${id}`, invoice);
      return res.status(200).json({ ok: true, invoice });
    }

    if (method === 'DELETE') {
      if (!id) return res.status(400).json({ ok: false, error: 'Missing invoice id.' });
      await redis.del(`invoice:${id}`);
      await redis.srem('invoice:ids', id);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (error) {
    console.error('Invoices API error:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Server error' });
  }
}
