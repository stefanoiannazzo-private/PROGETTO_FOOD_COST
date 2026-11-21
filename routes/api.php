<?php

use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\CompanyController;
use App\Http\Controllers\Api\DashboardController;
use App\Http\Controllers\Api\EmployeeController;
use App\Http\Controllers\Api\EquipmentController;
use App\Http\Controllers\Api\ImportController;
use App\Http\Controllers\Api\IngredientController;
use App\Http\Controllers\Api\PlatformController;
use App\Http\Controllers\Api\RecipeController;
use App\Http\Controllers\Api\SystemController;
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
Route::post('/system/deploy', [SystemController::class, 'deploy']);
Route::post('/system/first-admin', [SystemController::class, 'firstAdmin']);

// Accesso e sessione
Route::post('/auth/login', [AuthController::class, 'login']);
Route::post('/auth/logout', [AuthController::class, 'logout']);
Route::get('/auth/me', [AuthController::class, 'show']);
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
Route::get('/ingredients/{id}', [IngredientController::class, 'show']);
Route::post('/ingredients', [IngredientController::class, 'store']);
Route::patch('/ingredients/{id}', [IngredientController::class, 'update']);
Route::post('/ingredients/{id}/prices', [IngredientController::class, 'addPrice']);
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
Route::post('/tariffs/{id}/archive', [TariffController::class, 'archive']);
Route::post('/tariffs/{id}/restore', [TariffController::class, 'restore']);

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
Route::get('/recipes/{id}/valuation', [RecipeController::class, 'valuation']);
Route::get('/recipes/{id}/revisions', [RecipeController::class, 'revisions']);
Route::get('/recipes/{id}/revisions/{revisionId}', [RecipeController::class, 'revision']);
Route::post('/recipes/{id}/snapshots', [RecipeController::class, 'snapshot']);
Route::delete('/recipes/{id}', [RecipeController::class, 'destroy']);
Route::get('/snapshots/{id}', [RecipeController::class, 'showSnapshot']);

// Importazioni
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
    Route::get('/recipes', [PlatformController::class, 'recipes']);
    Route::get('/ingredients', [PlatformController::class, 'ingredients']);
    Route::get('/suppliers', [PlatformController::class, 'suppliers']);
    Route::get('/price-stats', [PlatformController::class, 'priceStats']);
    Route::get('/comparison-groups', [PlatformController::class, 'groups']);
    Route::post('/comparison-groups', [PlatformController::class, 'createGroup']);
    Route::get('/comparison-groups/{id}', [PlatformController::class, 'showGroup']);
    Route::patch('/comparison-groups/{id}', [PlatformController::class, 'updateGroup']);
    Route::delete('/comparison-groups/{id}', [PlatformController::class, 'deleteGroup']);
});
