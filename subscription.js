// Subscription gate for AZN Flight Radar.
// Requires Supabase JS v2 and config.js. Payment activation is intentionally
// disabled until a country-compatible payment provider and verified webhook exist.
(async function(){
 const root=document.getElementById('subscriptionGate');
 const mapEl=document.getElementById('map');
 const bottom=document.querySelector('.bottom');
 const ready=window.AZN_SUPABASE_URL && !window.AZN_SUPABASE_URL.includes('YOUR_')
   && window.AZN_SUPABASE_ANON_KEY && !window.AZN_SUPABASE_ANON_KEY.includes('YOUR_');
 function show(html){root.innerHTML=html;root.style.display='flex';mapEl.style.visibility='hidden';bottom.style.display='none';}
 function allow(){root.style.display='none';mapEl.style.visibility='visible';bottom.style.display='';}
 if(!ready || !window.supabase){
   show(`<section class="gateCard"><h2>✈ AZN Flight Radar</h2><p>برای فعال‌سازی ورود و اشتراک، ابتدا اطلاعات پروژه Supabase باید تنظیم و فایل SQL اجرا شود.</p><p class="small">این نسخه هنوز پرداخت واقعی را فعال نمی‌کند؛ ابتدا باید درگاه معتبر انتخاب و تأیید شود.</p></section>`);
   return;
 }
 const client=window.supabase.createClient(window.AZN_SUPABASE_URL,window.AZN_SUPABASE_ANON_KEY);
 const plans=[
  ['daily','یک‌روزه','۱ دلار'],
  ['monthly','یک‌ماهه','۵ دلار'],
  ['quarterly','سه‌ماهه','۱۲ دلار'],
  ['yearly','یک‌ساله','۳۹ دلار']
 ];
 function authPanel(){
  show(`<section class="gateCard"><h2>ورود یا ثبت‌نام</h2><p>با ایمیل خود وارد شوید؛ پس از ثبت‌نام، ۳ روز دسترسی آزمایشی فعال می‌شود.</p><input id="email" type="email" placeholder="ایمیل" /><input id="password" type="password" placeholder="رمز عبور" /><button id="signup">ثبت‌نام و شروع ۳ روز رایگان</button><button id="login">ورود</button><p id="authMsg" class="small"></p></section>`);
  document.getElementById('signup').onclick=async()=>{
   const {error}=await client.auth.signUp({email:document.getElementById('email').value,password:document.getElementById('password').value});
   document.getElementById('authMsg').textContent=error?error.message:'اگر تأیید ایمیل فعال است، ایمیل خود را تأیید کنید؛ سپس وارد شوید.';
  };
  document.getElementById('login').onclick=async()=>{
   const {error}=await client.auth.signInWithPassword({email:document.getElementById('email').value,password:document.getElementById('password').value});
   if(error)document.getElementById('authMsg').textContent=error.message;else await checkAccess();
  };
 }
 async function checkAccess(){
  const {data:{session}}=await client.auth.getSession();
  if(!session){authPanel();return;}
  const {data:ok,error}=await client.rpc('azn_has_flight_access');
  if(error){show(`<section class="gateCard"><h2>خطای بررسی اشتراک</h2><p>${error.message}</p><button onclick="location.reload()">تلاش دوباره</button></section>`);return;}
  if(ok){allow();return;}
  show(`<section class="gateCard"><h2>اشتراک شما فعال نیست</h2><p>برای ادامه استفاده، یکی از طرح‌ها را انتخاب کنید.</p><div class="plans">${plans.map(p=>`<div class="plan"><b>${p[1]}</b><strong>${p[2]}</strong><small>پرداخت پس از اتصال درگاه فعال می‌شود</small></div>`).join('')}</div><p class="small">پرداخت آنلاین هنوز در این نسخه متصل نشده است. هیچ مبلغی دریافت نمی‌شود.</p><button id="logout">خروج از حساب</button></section>`);
  document.getElementById('logout').onclick=async()=>{await client.auth.signOut();authPanel();};
 }
 await checkAccess();
 client.auth.onAuthStateChange(()=>setTimeout(checkAccess,0));
})();
