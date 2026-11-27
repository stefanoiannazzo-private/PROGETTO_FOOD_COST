<?php

use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\CompanyController;
use App\Http\Controllers\Api\DashboardController;
use App\Http\Controllers\Api\EmployeeController;
use App\Http\Controllers\Api\EquipmentController;
use App\Http\Controllers\Api\ImportController;
use App\Http\Controllers\Api\IngredientController;
use App\Http\Controllers\Api\PlatformController;
use App\Http\Controllers\Api\PromoterController;
use App\Http\Controllers\Api\RecipeController;
use App\Http\Controllers\Api\SystemController;
use App\Http\Controllers\Api\TariffBillController;
use App\Http\Controllers\Api\SupplierInvoiceController;
use App\Http\Controllers\Api\AlertController;
use App\Http\Controllers\Api\SupportController;
use App\Http\Controllers\Api\TariffController;
use App\Http\Controllers\Api\UserController;
use Illuminate\Support\Facades\Route;

/*
 * API di FOOD COST: stessi percorsi e metodi dell'originale (apps/api/src/routes), con prefisso /api.
 * Le rotte con segmento {id} accettano solo UUID: la verifica è nei controller, con gli stessi messaggi dell'originale.
 */

Route::get('/health', fn () => ['ok' => true]);
// Cron dell'hosting (Aruba: "Processi Cron" che richiama un indirizzo): fa avanzare i lavori e la pulizia.
Route::get('/cron', [SystemController::class, 'cron']);

// NUOVO: coefficiente di redditività (solo amministratore)
Route::get('/profitability', [\App\Http\Controllers\Api\ProfitabilityController::class, 'show']);
Route::put('/profitability/settings', [\App\Http\Controllers\Api\ProfitabilityController::class, 'updateSettings']);
Route::post('/profitability/fixed-costs', [\App\Http\Controllers\Api\ProfitabilityController::class, 'storeFixedCost']);
Route::put('/profitability/fixed-costs/{id}', [\App\Http\Controllers\Api\ProfitabilityController::class, 'updateFixedCost']);
Route::delete('/profitability/fixed-costs/{id}', [\App\Http\Controllers\Api\ProfitabilityController::class, 'destroyFixedCost']);
Route::put('/profitability/prices/{recipeId}', [\App\Http\Controllers\Api\ProfitabilityController::class, 'updatePrice']);
Route::post('/system/deploy', [SystemController::class, 'deploy']);
Route::post('/system/first-admin', [SystemController::class, 'firstAdmin']);

// NUOVO: richiesta di attivazione pubblica (link del promotore) e controllo del codice promo
Route::get('/public/promo/{code}', [\App\Http\Controllers\Api\SignupRequestController::class, 'checkCode']);
Route::post('/public/signup-requests', [\App\Http\Controllers\Api\SignupRequestController::class, 'store']);
// NUOVO: area Ordini — configurazione (menu, postazioni, sale e tavoli, menu digitale)
Route::prefix('/orders/setup')->controller(\App\Http\Controllers\Api\OrderSetupController::class)->group(function () {
    Route::get('/', 'index');
    Route::get('/sources', 'sources');
    Route::post('/stations', 'storeStation');
    Route::put('/stations/{id}', 'updateStation');
    Route::delete('/stations/{id}', 'destroyStation');
    Route::post('/sections', 'storeSection');
    Route::put('/sections/{id}', 'updateSection');
    Route::delete('/sections/{id}', 'destroySection');
    Route::post('/items', 'storeItem');
    Route::put('/items/{id}', 'updateItem');
    Route::patch('/items/{id}/availability', 'availability');
    Route::delete('/items/{id}', 'destroyItem');
    Route::post('/areas', 'storeArea');
    Route::put('/areas/{id}', 'updateArea');
    Route::delete('/areas/{id}', 'destroyArea');
    Route::post('/tables', 'storeTables');
    Route::put('/tables/{id}', 'updateTable');
    Route::delete('/tables/{id}', 'destroyTable');
    Route::put('/settings', 'updateSettings');
    Route::post('/reorder/{what}', 'reorder');
    Route::get('/guests', 'guests');
});
// NUOVO: area Ordini — servizio (sala, cucina e bancone, PIN, tablet di servizio)
Route::prefix('/orders')->controller(\App\Http\Controllers\Api\OrderServiceController::class)->group(function () {
    Route::get('/floor', 'floor');
    Route::get('/menu', 'menu');
    Route::post('/sessions', 'open');
    Route::get('/sessions/{id}', 'show');
    Route::patch('/sessions/{id}', 'update');
    Route::post('/sessions/{id}/tables', 'addTables');
    Route::delete('/sessions/{id}/tables/{tableId}', 'removeTable');
    Route::post('/sessions/{id}/send', 'send');
    Route::post('/sessions/{id}/go', 'go');
    Route::post('/sessions/{id}/served', 'served');
    Route::get('/sessions/{id}/bill', 'billPreview');
    Route::post('/sessions/{id}/close', 'close');
    Route::post('/items/{itemId}/cancel', 'cancelItem');
    Route::get('/kitchen', 'kitchen');
    Route::post('/kitchen/status', 'kitchenStatus');
    Route::put('/pin', 'setOwnPin');
    Route::get('/staff', 'staff');
    Route::put('/staff/{userId}/pin', 'setStaffPin');
    Route::post('/device/enable', 'enableDevice');
    Route::post('/device/disable', 'disableDevice');
    Route::post('/device/whoami', 'whoami');
    Route::post('/gifts/redeem', 'redeemGift');
});
// NUOVO: statistiche di vendita (area Ordini)
Route::get('/sales/stats', [\App\Http\Controllers\Api\SalesController::class, 'stats']);
// NUOVO: promemoria mensile fatture e bollette
Route::get('/reminders/current', [\App\Http\Controllers\Api\ReminderController::class, 'current']);
Route::post('/reminders/seen', [\App\Http\Controllers\Api\ReminderController::class, 'seen']);
Route::post('/reminders/done', [\App\Http\Controllers\Api\ReminderController::class, 'done']);
// NUOVO: menu digitale pubblico (QR), senza login
Route::get('/public/menu/t/{qr}', [\App\Http\Controllers\Api\PublicMenuController::class, 'showTable']);
Route::get('/public/menu/{token}', [\App\Http\Controllers\Api\PublicMenuController::class, 'show']);
Route::post('/public/menu/{token}/guests', [\App\Http\Controllers\Api\PublicMenuController::class, 'register']);
// NUOVO: «Invita un collega» (codice e link del ristoratore)
Route::get('/referral', [\App\Http\Controllers\Api\ReferralController::class, 'show']);
Route::post('/referral', [\App\Http\Controllers\Api\ReferralController::class, 'store']);

// Accesso e sessione
Route::post('/auth/login', [AuthController::class, 'login']);
Route::post('/auth/logout', [AuthController::class, 'logout']);
Route::get('/auth/me', [AuthController::class, 'show']);
Route::post('/auth/tour', [AuthController::class, 'tour']);
Route::post('/auth/company', [AuthController::class, 'company']);
Route::post('/auth/password/change', [AuthController::class, 'changePassword']);
Route::post('/auth/password/forgot', [AuthController::class, 'forgot']);
Route::post('/auth/password/reset', [AuthController::class, 'reset']);
Route::get('/auth/invitations/{token}', [AuthController::class, 'invitation']);
Route::post('/auth/invitations/accept', [AuthController::class, 'acceptInvitation']);

// Utenti e aziende
Route::get('/users/catalog', [UserController::class, 'catalog']);
Route::get('/users', [UserController::class, 'index']);
Route::post('/users/invitations', [UserController::class, 'invite']);
Route::delete('/users/invitations/{id}', [UserController::class, 'deleteInvitation']);
Route::patch('/users/{id}', [UserController::class, 'update']);
Route::post('/companies', [CompanyController::class, 'store']);
Route::patch('/companies/current', [CompanyController::class, 'updateCurrent']);

// Ingredienti
Route::get('/ingredients', [IngredientController::class, 'index']);
Route::get('/ingredients/categories', [IngredientController::class, 'categories']);
Route::get('/ingredients/suppliers', [IngredientController::class, 'suppliers']);
Route::get('/ingredients/agents', [IngredientController::class, 'agents']);
Route::get('/ingredients/{id}', [IngredientController::class, 'show']);
Route::post('/ingredients', [IngredientController::class, 'store']);
Route::patch('/ingredients/{id}', [IngredientController::class, 'update']);
Route::post('/ingredients/{id}/prices', [IngredientController::class, 'addPrice']);
Route::post('/ingredients/{id}/prices/align', [IngredientController::class, 'alignPrices']);
Route::delete('/ingredients/{id}/prices/{priceId}', [IngredientController::class, 'deletePrice']);
Route::post('/ingredients/{id}/archive', [IngredientController::class, 'archive']);
Route::post('/ingredients/{id}/restore', [IngredientController::class, 'restore']);
Route::delete('/ingredients/{id}', [IngredientController::class, 'destroy']);

// Utenze
Route::get('/tariffs', [TariffController::class, 'index']);
Route::post('/tariffs/bill-preview', [TariffController::class, 'billPreview']);
Route::get('/tariffs/{id}', [TariffController::class, 'show']);
Route::post('/tariffs', [TariffController::class, 'store']);
Route::patch('/tariffs/{id}', [TariffController::class, 'update']);
Route::post('/tariffs/{id}/versions', [TariffController::class, 'addVersion']);
Route::delete('/tariffs/{id}/versions/{versionId}', [TariffController::class, 'deleteVersion']);
Route::put('/tariffs/{id}/versions/{versionId}', [TariffController::class, 'updateVersion']);
Route::delete('/tariffs/{id}', [TariffController::class, 'destroy']);
Route::post('/tariffs/{id}/archive', [TariffController::class, 'archive']);
Route::post('/tariffs/{id}/restore', [TariffController::class, 'restore']);
// NUOVO — bollette delle utenze (archivio e lettura automatica)
Route::get('/tariffs/{id}/bills', [TariffBillController::class, 'index']);
Route::post('/tariffs/{id}/bills', [TariffBillController::class, 'upload']);
Route::get('/tariffs/{id}/bills/{billId}/file', [TariffBillController::class, 'file']);
Route::delete('/tariffs/{id}/bills/{billId}', [TariffBillController::class, 'destroy']);

// Strumenti
Route::get('/equipment', [EquipmentController::class, 'index']);
Route::get('/equipment/{id}', [EquipmentController::class, 'show']);
Route::post('/equipment', [EquipmentController::class, 'store']);
Route::patch('/equipment/{id}', [EquipmentController::class, 'update']);
Route::post('/equipment/{id}/archive', [EquipmentController::class, 'archive']);
Route::post('/equipment/{id}/restore', [EquipmentController::class, 'restore']);
Route::delete('/equipment/{id}', [EquipmentController::class, 'destroy']);

// Dipendenti
Route::get('/employees', [EmployeeController::class, 'index']);
Route::post('/employees/cost-preview', [EmployeeController::class, 'costPreview']);
Route::get('/employees/{id}', [EmployeeController::class, 'show']);
Route::post('/employees', [EmployeeController::class, 'store']);
Route::patch('/employees/{id}', [EmployeeController::class, 'update']);
Route::post('/employees/{id}/costs', [EmployeeController::class, 'addCost']);
Route::delete('/employees/{id}/costs/{configId}', [EmployeeController::class, 'deleteCost']);
Route::post('/employees/{id}/archive', [EmployeeController::class, 'archive']);
Route::post('/employees/{id}/restore', [EmployeeController::class, 'restore']);

// Ricette e snapshot
Route::get('/recipes', [RecipeController::class, 'index']);
Route::get('/recipes/categories', [RecipeController::class, 'categories']);
Route::get('/recipes/options', [RecipeController::class, 'options']);
Route::post('/recipes/preview', [RecipeController::class, 'preview']);
Route::get('/recipes/{id}', [RecipeController::class, 'show']);
Route::post('/recipes', [RecipeController::class, 'store']);
Route::put('/recipes/{id}', [RecipeController::class, 'update']);
Route::post('/recipes/{id}/duplicate', [RecipeController::class, 'duplicate']);
Route::post('/recipes/{id}/archive', [RecipeController::class, 'archive']);
Route::post('/recipes/{id}/restore', [RecipeController::class, 'restore']);
Route::post('/recipes/{id}/activate', [RecipeController::class, 'activate']);
Route::post('/recipes/{id}/draft', [RecipeController::class, 'toDraft']);
Route::get('/recipes/{id}/valuation', [RecipeController::class, 'valuation']);
Route::get('/recipes/{id}/revisions', [RecipeController::class, 'revisions']);
Route::get('/recipes/{id}/revisions/{revisionId}', [RecipeController::class, 'revision']);
Route::post('/recipes/{id}/snapshots', [RecipeController::class, 'snapshot']);
Route::delete('/recipes/{id}', [RecipeController::class, 'destroy']);
Route::get('/snapshots/{id}', [RecipeController::class, 'showSnapshot']);

// Importazioni
// NUOVO — assistenza: richieste dei ristoratori e console del supporto
Route::get('/support/info', [SupportController::class, 'info']);
Route::get('/support/tickets', [SupportController::class, 'index']);
Route::post('/support/tickets', [SupportController::class, 'store']);
Route::get('/support/tickets/{id}', [SupportController::class, 'show']);
Route::post('/support/tickets/{id}/messages', [SupportController::class, 'reply']);
Route::post('/support/tickets/{id}/close', [SupportController::class, 'close']);
Route::get('/support/tickets/{id}/attachments/{messageId}', [SupportController::class, 'attachmentFile']);
Route::get('/platform/support', [SupportController::class, 'platformIndex']);
Route::get('/platform/support/{id}', [SupportController::class, 'show']);
Route::post('/platform/support/{id}/messages', [SupportController::class, 'platformReply']);
Route::post('/platform/support/{id}/status', [SupportController::class, 'platformStatus']);
// NUOVO — avvisi di variazione dei costi (ricette e prodotti non ancora rivisti dall'utente)
Route::get('/alerts', [AlertController::class, 'index']);
Route::post('/alerts/seen', [AlertController::class, 'seen']);
// NUOVO — fatture elettroniche dei fornitori (XML / P7M / ZIP) caricate dalla pagina Importazioni
Route::get('/supplier-invoices', [SupplierInvoiceController::class, 'index']);
Route::post('/supplier-invoices', [SupplierInvoiceController::class, 'upload']);
Route::get('/supplier-invoices/{id}', [SupplierInvoiceController::class, 'show']);
Route::get('/supplier-invoices/{id}/file', [SupplierInvoiceController::class, 'file']);
Route::post('/supplier-invoices/{id}/confirm', [SupplierInvoiceController::class, 'confirm']);
Route::delete('/supplier-invoices/{id}', [SupplierInvoiceController::class, 'destroy']);
Route::get('/imports/fields/{type}', [ImportController::class, 'fields']);
Route::get('/imports/templates/{file}', [ImportController::class, 'template']);
Route::get('/imports', [ImportController::class, 'index']);
Route::post('/imports', [ImportController::class, 'upload']);
Route::get('/imports/{id}', [ImportController::class, 'show']);
Route::post('/imports/{id}/preview', [ImportController::class, 'preview']);
Route::post('/imports/{id}/validate', [ImportController::class, 'validateImport']);
Route::get('/imports/{id}/rows', [ImportController::class, 'rows']);
Route::post('/imports/{id}/confirm', [ImportController::class, 'confirm']);
Route::post('/imports/{id}/cancel', [ImportController::class, 'cancel']);
Route::get('/imports/{id}/report.csv', [ImportController::class, 'report']);

// Cruscotto
Route::get('/dashboard', [DashboardController::class, 'show']);

// NUOVO: console del superadmin (piattaforma SaaS)
Route::prefix('platform')->group(function () {
    Route::get('/overview', [PlatformController::class, 'overview']);
    Route::get('/companies', [PlatformController::class, 'companies']);
    Route::post('/companies', [PlatformController::class, 'createCompany']);
    Route::patch('/companies/{id}', [PlatformController::class, 'updateCompany']);
    Route::post('/invitations/{id}/send', [PlatformController::class, 'sendInvitation']);
    Route::post('/invitations/{id}/renew', [PlatformController::class, 'renewInvitation']);
    Route::get('/recipes', [PlatformController::class, 'recipes']);
    Route::get('/ingredients', [PlatformController::class, 'ingredients']);
    Route::get('/suppliers', [PlatformController::class, 'suppliers']);
    Route::get('/price-stats', [PlatformController::class, 'priceStats']);
    Route::get('/comparison-groups', [PlatformController::class, 'groups']);
    Route::post('/comparison-groups', [PlatformController::class, 'createGroup']);
    Route::get('/comparison-groups/{id}', [PlatformController::class, 'showGroup']);
    Route::patch('/comparison-groups/{id}', [PlatformController::class, 'updateGroup']);
    Route::delete('/comparison-groups/{id}', [PlatformController::class, 'deleteGroup']);
    // NUOVO: promotori e codici promo (referral)
    Route::get('/promoters', [PromoterController::class, 'index']);
    Route::post('/promoters', [PromoterController::class, 'store']);
    Route::get('/promoters/{id}', [PromoterController::class, 'show']);
    Route::patch('/promoters/{id}', [PromoterController::class, 'update']);
    Route::get('/users', [PromoterController::class, 'users']);
    Route::get('/signup-requests', [\App\Http\Controllers\Api\SignupRequestController::class, 'index']);
    Route::post('/signup-requests/{id}/approve', [\App\Http\Controllers\Api\SignupRequestController::class, 'approve']);
    Route::post('/signup-requests/{id}/reject', [\App\Http\Controllers\Api\SignupRequestController::class, 'reject']);
});
