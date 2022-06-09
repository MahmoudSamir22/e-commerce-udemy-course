const stripe = require("stripe")(process.env.STRIPE_SECRET);
const asyncHandler = require("express-async-handler");
const factory = require("./factoryHandler");
const ApiError = require("../utils/apiErrors");

const Order = require("../models/order.model");
const Cart = require("../models/cart.model");
const Product = require("../models/product.model");
const User = require("../models/user.model");

// @desc Create cash order
// @route POST /api/v1/order/cartId
// @access Private/User
exports.createCashOrder = asyncHandler(async (req, res, next) => {
  const taxPrice = 0;
  const shippingPrice = 0;
  // 1) Get cart depends on cartId
  const cart = await Cart.findById(req.params.cartId);
  if (!cart) {
    return next(
      new ApiError(`There is no cart with this id: ${req.params.cartId}`, 404)
    );
  }
  // 2) Get order price depends on cart price (check if coupon applied)
  const orderPrice = cart.totalPriceAfterDiscount
    ? cart.totalPriceAfterDiscount
    : cart.totalCartPrice;
  const totalOrderPrice = orderPrice + taxPrice + shippingPrice;
  // 3) Create order with default paymentMethod cash
  const order = await Order.create({
    user: req.user._id,
    cartItems: cart.cartItems,
    shippingAddress: req.body.shippingAddress,
    totalOrderPrice,
  });
  // 4) After create order, increament product sold, and decrement product quantity
  if (order) {
    const bulkOptions = cart.cartItems.map((item) => ({
      updateOne: {
        filter: { _id: item.product },
        update: { $inc: { sold: +item.quantity, quantity: -item.quantity } },
      },
    }));
    await Product.bulkWrite(bulkOptions, {});
    // 5) Clear card depends on cartId
    await Cart.findByIdAndDelete(req.params.cartId);
  }
  res.status(201).json({ status: "OK", data: order });
});

exports.filterOrderLoggedUser = asyncHandler(async (req, res, next) => {
  if (req.user.role === "user") req.filter = { user: req.user._id };
  next();
});

exports.findAllOrders = factory.getAll(Order);

exports.findOrder = factory.getOne(Order);

exports.updadeOrderToPaid = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id);
  if (!order)
    return next(
      new ApiError(`There is no such order with id: ${req.params.id}`, 404)
    );

  order.isPaied = true;
  order.paidAt = Date.now();

  await order.save();
  res.status(200).json({ status: "Success", data: order });
});

exports.updadeOrderToDeliverd = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id);
  if (!order)
    return next(
      new ApiError(`There is no such order with id: ${req.params.id}`, 404)
    );

  order.isDelivered = true;
  order.deliveredAt = Date.now();

  await order.save();
  res.status(200).json({ status: "Success", data: order });
});

// @desc Get Check out session from stripe and send it as a response
// @route GET /api/v1/order/checkout-session/cartId
// @access Private/User

exports.checkOutSession = asyncHandler(async (req, res, next) => {
  const taxPrice = 0;
  const shippingPrice = 0;
  // 1) Get cart depends on cartId
  const cart = await Cart.findById(req.params.cartId);
  if (!cart) {
    return next(
      new ApiError(`There is no cart with this id: ${req.params.cartId}`, 404)
    );
  }
  // 2) Get order price depends on cart price (check if coupon applied)
  const orderPrice = cart.totalPriceAfterDiscount
    ? cart.totalPriceAfterDiscount
    : cart.totalCartPrice;
  const totalOrderPrice = orderPrice + taxPrice + shippingPrice;

  const session = await stripe.checkout.sessions.create({
    line_items: [
      {
        name: req.user.name,
        amount: totalOrderPrice * 100,
        currency: "egp",
        quantity: 1,
      },
    ],
    mode: "payment",
    success_url: `${req.protocol}://${req.get("host")}/orders`,
    cancel_url: `${req.protocol}://${req.get("host")}/cart`,
    customer_email: req.user.email,
    client_reference_id: req.params.cartId,
    metadata: req.body.shippingAddress,
  });

  res.status(200).json({ status: "success", data: session });
});

const createCardOrder = async (session) => {
  const cartId = session.client_reference_id
  const shippingAddress = session.metadata
  const orderPrice = session.amount_total / 100

  const cart = await Cart.findById(cartId)
  const user = await User.findOne({email: session.customer_email})

  // 3) Create order with default paymentMethod card
  const order = await Order.create({
    user: user._id,
    cartItems: cart.cartItems,
    shippingAddress,
    totalOrderPrice: orderPrice,
    isPaied: true,
    paidAt: Date.now(),
    paymentMethodType: 'card'
  });

  // 4) After create order, increament product sold, and decrement product quantity
  if (order) {
    const bulkOptions = cart.cartItems.map((item) => ({
      updateOne: {
        filter: { _id: item.product },
        update: { $inc: { sold: +item.quantity, quantity: -item.quantity } },
      },
    }));
    await Product.bulkWrite(bulkOptions, {});
    // 5) Clear card depends on cartId
    await Cart.findByIdAndDelete(cartId);
  }
}

exports.webhookCheckOut = asyncHandler(async (req, res, next) => {
  const sig = req.headers["stripe-signature"];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if(event.type === "checkout.session.completed"){
    // 1) Create Order
    createCardOrder(event.data.object)
  }
  res.status(200).json({recived: true})
});
