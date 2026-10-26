-- Starting data: the menu and shop details that were on the page

INSERT OR IGNORE INTO products (category, name, price, image_url, sort) VALUES
  ('عصائر', 'عصير بطيخ', 100, 'images/j-watermelon.jpg', 1),
  ('عصائر', 'عصير رمان', 100, 'images/j-pomegranate.jpg', 2),
  ('عصائر', 'عصير كيوي', 100, 'images/j-kiwi.jpg', 3),
  ('عصائر', 'عصير أفوكادو', 100, 'images/j-avocado.jpg', 4),
  ('عصائر', 'عصير جوافة', 100, 'images/j-guava.jpg', 5),
  ('عصائر', 'عصير مانجو', 100, 'images/j-mango.jpg', 6),
  ('سموزي', 'سموزي بطيخ', 100, 'images/s-watermelon.jpg', 11),
  ('سموزي', 'سموزي رمان', 100, 'images/s-pomegranate.jpg', 12),
  ('سموزي', 'سموزي كيوي', 100, 'images/s-kiwi.jpg', 13),
  ('سموزي', 'سموزي أفوكادو', 100, 'images/s-avocado.jpg', 14),
  ('سموزي', 'سموزي جوافة', 100, 'images/s-guava.jpg', 15),
  ('سموزي', 'سموزي مانجو', 100, 'images/s-mango.jpg', 16),
  ('ميلك شيك', 'ميلك شيك بطيخ', 50, 'images/m-watermelon.jpg', 21),
  ('ميلك شيك', 'ميلك شيك رمان', 50, 'images/m-pomegranate.jpg', 22),
  ('ميلك شيك', 'ميلك شيك كيوي', 50, 'images/m-kiwi.jpg', 23),
  ('ميلك شيك', 'ميلك شيك أفوكادو', 50, 'images/m-avocado.jpg', 24),
  ('ميلك شيك', 'ميلك شيك جوافة', 50, 'images/m-guava.jpg', 25),
  ('ميلك شيك', 'ميلك شيك مانجو', 50, 'images/m-mango.jpg', 26),
  ('أيس كريم', 'أيس كريم فستق', 50, 'images/i-pistachio.jpg', 31),
  ('أيس كريم', 'أيس كريم شوكليت', 50, 'images/i-chocolate.jpg', 32),
  ('أيس كريم', 'أيس كريم نوتيلا', 50, 'images/i-nutella.jpg', 33),
  ('أيس كريم', 'أيس كريم فانيليا', 50, 'images/i-vanilla.jpg', 34),
  ('أيس كريم', 'أيس كريم مانجو', 50, 'images/i-mango.jpg', 35),
  ('أيس كريم', 'أيس كريم فراولة', 50, 'images/i-strawberry.jpg', 36);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('tagline', 'عصائر فريش وأيس كريم طازة كل يوم، من محلنا لبيتك.'),
  ('about', 'محل عيلة صغير. بنعصر كل يوم الصبح بدري، ومفيش حاجة عندنا بايتة.'),
  ('address', '12 شارع النخيل، جنب الصيدلية'),
  ('phone', '01060063622'),
  ('whatsapp', '01060063622'),
  ('vodafone_cash', '01060063622'),
  ('instapay', ''),
  ('hours', '[{"open":"07:00","close":"23:00","closed":false},{"open":"07:00","close":"23:00","closed":false},{"open":"07:00","close":"23:00","closed":false},{"open":"07:00","close":"23:00","closed":false},{"open":"07:00","close":"23:00","closed":false},{"open":"14:00","close":"23:00","closed":false},{"open":"07:00","close":"23:00","closed":false}]');
